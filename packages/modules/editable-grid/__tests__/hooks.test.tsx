// Hook layer regression tests for the editable-grid module.
//
// Mounts the library hooks (useEditBuffer + useApplyChangeSet) inside a tiny
// harness component and asserts the boring path: edit a cell → buffer dirties
// → save → kernel postJson called with the right ApplyChangeSet shape →
// dirty clears.
//
// Does NOT mount AG Grid — that integration is covered by the live
// .config/mise/scripts/repository/spike-hr-screenshots.ts Playwright run. The Vitest layer catches
// the "I refactored the module and broke the apply payload shape" class of
// regression that screenshots would miss.

import { useEffect, useRef, useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { act, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type {
  ApplyChangeSet,
  AppliedChangeSet,
  KernelClient,
  Schema,
  VisibleRecord,
} from "@contracts";
import { splitCustomFieldsFromWrites } from "../../../engines/custom-field-projection/index";

import {
  useApplyChangeSet,
  isSingleFlightBlocked,
  type ApplyChangeSetPayload,
} from "../hooks/useApplyChangeSet";
import { useApplyChangeSetBatch } from "../hooks/useApplyChangeSetBatch";
import { useEditBuffer } from "../hooks/useEditBuffer";
import {
  useEditableRowVersionGrid,
  type PreparedAtomicGridSave,
  type SaveOutcome,
  type StageBulkUpdateResult,
} from "../index";
import { dateAfter, dateBefore, type FieldValidator } from "@engines/field-validation/index";
import { fieldSetterFromSurface, invalidRuleFromSurface, testSchemaConfig } from "./test-schema";

function makeFakeClient(
  postResult: AppliedChangeSet | (() => Promise<AppliedChangeSet>) = {
    id: 1,
    schema_revision_id: "1",
  },
): KernelClient & { postJson: ReturnType<typeof vi.fn>; getJson: ReturnType<typeof vi.fn> } {
  const postJson = vi.fn(async (_path: string, _body: unknown) => {
    if (typeof postResult === "function") return postResult();
    return postResult;
  });
  const getJson = vi.fn(async (_path: string) => []);
  return { postJson, getJson } as ReturnType<typeof makeFakeClient>;
}

function testApplyPayload(changeTypeId: string, idempotencyKey: string): ApplyChangeSetPayload {
  return {
    app_id: "hc",
    customer_id: "demo",
    source_kind: "data_import",
    source_ref: "run-1",
    idempotency_key: idempotencyKey,
    mode: "mainline",
    change_type_id: changeTypeId,
    writes: [],
  };
}

type HarnessProps = {
  client: KernelClient;
  onState?: (state: { isDirty: boolean; cellCount: number; submitting: boolean }) => void;
};

function Harness(props: HarnessProps) {
  const { buffer, set, clear, isDirty } = useEditBuffer();
  const { submitting, apply } = useApplyChangeSet(props.client);

  useEffect(() => {
    props.onState?.({ isDirty, cellCount: buffer.cellCount, submitting });
  });

  return (
    <div>
      <span data-testid="dirty">{isDirty ? `dirty:${buffer.cellCount}` : "clean"}</span>
      <span data-testid="submitting">{submitting ? "submitting" : "idle"}</span>
      <button
        data-testid="edit"
        onClick={() =>
          set({ rowKey: "rec-1", fieldId: "title" }, { type: "text", value: "edited" }, "user", {
            modelId: "position",
            recordKey: { type: "record_id", value: "rec-1" },
            effectiveStart: "2026-05-13",
          })
        }
      >
        edit
      </button>
      <button
        data-testid="edit-second"
        onClick={() =>
          set({ rowKey: "rec-1", fieldId: "level" }, { type: "text", value: "L5" }, "user", {
            modelId: "position",
            recordKey: { type: "record_id", value: "rec-1" },
            effectiveStart: "2026-05-13",
          })
        }
      >
        edit second
      </button>
      <button
        data-testid="save"
        onClick={async () => {
          const writes = buffer.entries().map((e) => ({
            model_id: e.meta!.modelId,
            record_key: e.meta!.recordKey,
            effective_start: e.meta!.effectiveStart,
            values: { [e.addr.fieldId]: e.value! },
          }));
          try {
            const result = await apply({
              app_id: "hc",
              customer_id: "demo",
              source_kind: "ui",
              mode: "mainline",
              writes,
            });
            if (!isSingleFlightBlocked(result)) {
              clear();
            }
          } catch {
            // Swallow at the harness boundary so React event handler doesn't
            // surface an unhandled rejection. The hook still tracked the
            // ErrorEnvelope into its state; real apps render that to the user.
          }
        }}
      >
        save
      </button>
      <button
        data-testid="bad-save"
        onClick={async () => {
          try {
            await apply({
              app_id: "hc",
              customer_id: "demo",
              source_kind: "ui",
              mode: "mainline",
              notes: BigInt(1) as unknown as string,
              writes: [],
            });
          } catch {
            // The harness intentionally feeds a non-serializable payload to
            // prove the hook releases its single-flight fence before returning
            // the normalized client error.
          }
        }}
      >
        bad save
      </button>
    </div>
  );
}

describe("editable-grid library hooks", () => {
  it("edit → dirty buffer carries snapshot meta from edit time", async () => {
    const user = userEvent.setup();
    render(<Harness client={makeFakeClient()} />);

    expect(screen.getByTestId("dirty").textContent).toBe("clean");
    await user.click(screen.getByTestId("edit"));
    expect(screen.getByTestId("dirty").textContent).toBe("dirty:1");
  });

  it("save: posts to /api/apply with ApplyChangeSet shape carrying idempotency_key + writes", async () => {
    const user = userEvent.setup();
    const client = makeFakeClient();
    render(<Harness client={client} />);

    await user.click(screen.getByTestId("edit"));
    await user.click(screen.getByTestId("save"));

    expect(client.postJson).toHaveBeenCalledTimes(1);
    const [path, body] = client.postJson.mock.calls[0]!;
    expect(path).toBe("/api/apply");

    const payload = body as ApplyChangeSet;
    expect(payload.app_id).toBe("hc");
    expect(payload.customer_id).toBe("demo");
    expect(payload.source_kind).toBe("ui");
    expect(payload.mode).toBe("mainline");
    expect(payload.idempotency_key).toMatch(/[0-9a-f-]{36}/i); // UUID
    expect(payload.writes).toHaveLength(1);
    const w = payload.writes[0]!;
    expect(w.model_id).toBe("position");
    expect(w.record_key).toEqual({ type: "record_id", value: "rec-1" });
    expect(w.effective_start).toBe("2026-05-13");
    expect(w.values).toEqual({ title: { type: "text", value: "edited" } });
  });

  it("save success: clears dirty + frees idempotency_key for the next batch", async () => {
    const user = userEvent.setup();
    const client = makeFakeClient();
    render(<Harness client={client} />);

    await user.click(screen.getByTestId("edit"));
    await user.click(screen.getByTestId("save"));
    expect(screen.getByTestId("dirty").textContent).toBe("clean");

    // Second edit + save should issue a NEW idempotency_key (different UUID).
    await user.click(screen.getByTestId("edit"));
    await user.click(screen.getByTestId("save"));
    expect(client.postJson).toHaveBeenCalledTimes(2);
    const firstKey = (client.postJson.mock.calls[0]![1] as ApplyChangeSet).idempotency_key;
    const secondKey = (client.postJson.mock.calls[1]![1] as ApplyChangeSet).idempotency_key;
    expect(firstKey).toBeTruthy();
    expect(secondKey).toBeTruthy();
    expect(firstKey).not.toBe(secondKey);
  });

  it("save: preserves caller-provided deterministic idempotency_key", async () => {
    const client = makeFakeClient();
    const { result } = renderHook(() => useApplyChangeSet(client));
    const payload: Omit<ApplyChangeSet, "idempotency_key"> & {
      idempotency_key: string;
    } = {
      app_id: "hc",
      customer_id: "demo",
      source_kind: "data_import",
      source_ref: "run_123",
      idempotency_key: "hc-csv-import:run_123:mainline:employee_update",
      mode: "mainline",
      change_type_id: "employee_update",
      writes: [],
    };

    await act(async () => {
      await result.current.apply(payload);
    });

    expect(client.postJson).toHaveBeenCalledTimes(1);
    const posted = client.postJson.mock.calls[0]![1] as ApplyChangeSet;
    expect(posted.idempotency_key).toBe(payload.idempotency_key);
  });

  it("apply batch: applies groups in order and stops on first failed group", async () => {
    const employeePayload = testApplyPayload("employee_update", "employee-key");
    const positionPayload = testApplyPayload("position_update", "position-key");
    const orgPayload = testApplyPayload("org_assignment_update", "org-key");
    const apply = vi.fn(async (payload: ApplyChangeSetPayload) => {
      if (payload.change_type_id === "position_update") {
        throw { code: "kernel_failure", message: "position failed", details: [] };
      }
      return {
        id: payload.change_type_id === "employee_update" ? 101 : 103,
        schema_revision_id: "1",
      };
    });
    const { result } = renderHook(() => useApplyChangeSetBatch({ apply }));

    let batchResult: Awaited<ReturnType<typeof result.current.applyBatch>> | null = null;
    await act(async () => {
      batchResult = await result.current.applyBatch([
        { key: "employee_update", payload: employeePayload },
        { key: "position_update", payload: positionPayload },
        { key: "org_assignment_update", payload: orgPayload },
      ]);
    });

    expect(apply).toHaveBeenCalledTimes(2);
    expect(apply.mock.calls[0]![0]).toBe(employeePayload);
    expect(apply.mock.calls[1]![0]).toBe(positionPayload);
    expect(batchResult).toEqual({
      ok: false,
      applied: [
        {
          key: "employee_update",
          payload: employeePayload,
          appliedChangeSetId: 101,
        },
      ],
      failure: {
        key: "position_update",
        payload: positionPayload,
        error: "position failed",
      },
    });
  });

  it("save failure: keeps idempotency_key stable for retry", async () => {
    const user = userEvent.setup();
    let attempt = 0;
    const client = makeFakeClient(async () => {
      attempt += 1;
      if (attempt === 1) throw { code: "kernel_failure", message: "boom", details: [] };
      return { id: 7, schema_revision_id: "1" };
    });
    render(<Harness client={client} />);

    await user.click(screen.getByTestId("edit"));

    // First save throws (mid-component-handler); React Testing Library swallows
    // it, but the buffer should remain dirty so the user can retry.
    await act(async () => {
      try {
        await user.click(screen.getByTestId("save"));
      } catch {
        /* expected */
      }
    });
    expect(screen.getByTestId("dirty").textContent).toBe("dirty:1");

    // Retry. Same idempotency_key — kernel can dedupe partial-applied writes.
    await user.click(screen.getByTestId("save"));
    const firstKey = (client.postJson.mock.calls[0]![1] as ApplyChangeSet).idempotency_key;
    const retryKey = (client.postJson.mock.calls[1]![1] as ApplyChangeSet).idempotency_key;
    expect(firstKey).toBe(retryKey);
    expect(screen.getByTestId("dirty").textContent).toBe("clean");
  });

  it("save failure: changed payload gets a fresh idempotency_key on retry", async () => {
    const user = userEvent.setup();
    let attempt = 0;
    const client = makeFakeClient(async () => {
      attempt += 1;
      if (attempt === 1) throw { code: "kernel_failure", message: "boom", details: [] };
      return { id: 8, schema_revision_id: "1" };
    });
    render(<Harness client={client} />);

    await user.click(screen.getByTestId("edit"));
    await act(async () => {
      try {
        await user.click(screen.getByTestId("save"));
      } catch {
        /* expected */
      }
    });
    expect(screen.getByTestId("dirty").textContent).toBe("dirty:1");

    await user.click(screen.getByTestId("edit-second"));
    expect(screen.getByTestId("dirty").textContent).toBe("dirty:2");

    await user.click(screen.getByTestId("save"));

    expect(client.postJson).toHaveBeenCalledTimes(2);
    const firstPayload = client.postJson.mock.calls[0]![1] as ApplyChangeSet;
    const retryPayload = client.postJson.mock.calls[1]![1] as ApplyChangeSet;
    expect(firstPayload.idempotency_key).toBeTruthy();
    expect(retryPayload.idempotency_key).toBeTruthy();
    expect(firstPayload.idempotency_key).not.toBe(retryPayload.idempotency_key);
    expect(firstPayload.writes).toHaveLength(1);
    expect(retryPayload.writes).toHaveLength(2);
    expect(screen.getByTestId("dirty").textContent).toBe("clean");
  });

  it("apply serialization failure releases the single-flight fence", async () => {
    const user = userEvent.setup();
    const client = makeFakeClient();
    render(<Harness client={client} />);

    await user.click(screen.getByTestId("bad-save"));

    expect(screen.getByTestId("submitting").textContent).toBe("idle");
    expect(client.postJson).not.toHaveBeenCalled();

    await user.click(screen.getByTestId("edit"));
    await user.click(screen.getByTestId("save"));

    expect(client.postJson).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("dirty").textContent).toBe("clean");
  });

  it("stageNewRecord: drafts a row, prepends to surfaceProps.rows, save emits create-write WITHOUT record_key", async () => {
    // Mounts the full module hook (not just the buffer harness) to exercise:
    //   1. controller.stageNewRecord(values) — synthesizes tmp:${uuid}
    //      rowKey, stages N field entries with meta.recordKey === undefined.
    //   2. controller.newRowDrafts — synthesized VisibleRecord per staged
    //      row, with record_id === tempRowKey.
    //   3. surfaceProps.rows — hook prepends drafts to the rows the app
    //      passed in, so AG Grid renders draft + server records together.
    //   4. controller.save() — produces an ApplyChangeSet whose write OMITS
    //      `record_key`. The kernel's `resolve_or_create_subject_record`
    //      branches on `Some` vs `None`; a serialized `null` would break
    //      that branch (TypeScript's optional `?:` semantics make absent
    //      vs null distinct on the wire).
    //
    // The "edit existing alongside new" path is covered by the engine's
    // `toApplyChangeSet` grouping logic (engine groups by rowKey, so the
    // new-record's tempRowKey and the existing record_id stay separate
    // writes). Mounting both through this hook would require AG Grid;
    // those two paths converge in the same `entriesToWrites` builder,
    // which this test exercises through the hook surface.

    const user = userEvent.setup();
    const client = makeFakeClient();

    type Snapshot = {
      dirtyCount: number;
      newRowCount: number;
      surfaceRowCount: number;
      tempKey?: string;
    };
    let lastSnapshot: Snapshot | null = null;

    function NewRecordHarness() {
      const existingRow = {
        record_id: "rec-existing-1",
        effective_start: "2026-05-13",
        effective_end: null,
        custom_fields: [],
        values: { title: { type: "text" as const, value: "old" } },
      };
      const { controller, surfaceProps } = useEditableRowVersionGrid({
        modelId: "position",
        asOf: "2026-05-13",
        scope: { appId: "hc", customerId: "demo" },
        rows: [existingRow],
        client,
        // Fix #3 added a save-time guardrail that throws when no
        // resolution path produces a non-empty change_type id; the
        // legacy default of `""` is no longer accepted. Tests that
        // call `save()` MUST now thread a `changeTypeId` (or
        // `inferChangeType`).
        changeTypeId: "position_update",
        ...testSchemaConfig(),
      });
      const snapshot: Snapshot = {
        dirtyCount: controller.dirtyCount,
        newRowCount: controller.newRowDrafts.length,
        surfaceRowCount: surfaceProps.rows.length,
        tempKey: controller.newRowDrafts[0]?.record_id,
      };
      lastSnapshot = snapshot;
      return (
        <div>
          <button
            data-testid="stage-new"
            onClick={() => {
              controller.stageNewRecord({
                title: { type: "text", value: "Brand New Position" },
                level: { type: "text", value: "L5" },
              });
            }}
          >
            stage
          </button>
          <button data-testid="save" onClick={() => void controller.save()}>
            save
          </button>
        </div>
      );
    }

    render(<NewRecordHarness />);

    expect((lastSnapshot as Snapshot | null)?.dirtyCount).toBe(0);
    expect((lastSnapshot as Snapshot | null)?.surfaceRowCount).toBe(1); // just the existing row

    await user.click(screen.getByTestId("stage-new"));

    expect((lastSnapshot as Snapshot | null)?.dirtyCount).toBe(2); // two staged fields → two cells
    expect((lastSnapshot as Snapshot | null)?.newRowCount).toBe(1);
    expect((lastSnapshot as Snapshot | null)?.surfaceRowCount).toBe(2); // draft prepended
    expect((lastSnapshot as Snapshot | null)?.tempKey).toMatch(/^tmp:[0-9a-f-]{36}$/i);

    await user.click(screen.getByTestId("save"));

    expect(client.postJson).toHaveBeenCalledTimes(1);
    const [path, body] = client.postJson.mock.calls[0]!;
    expect(path).toBe("/api/apply");

    const payload = body as ApplyChangeSet;
    expect(payload.writes).toHaveLength(1);
    const newRecordWrite = payload.writes[0]!;
    expect(newRecordWrite.model_id).toBe("position");
    expect(newRecordWrite.effective_start).toBe("2026-05-13");
    // CRITICAL: `record_key` must be ABSENT, not null. The kernel's
    // `resolve_or_create_subject_record` branches on `Some` vs `None`.
    expect(Object.prototype.hasOwnProperty.call(newRecordWrite, "record_key")).toBe(false);
    expect(newRecordWrite.values).toEqual({
      title: { type: "text", value: "Brand New Position" },
      level: { type: "text", value: "L5" },
    });
  });

  it("prepares and acknowledges one exact atomic-save snapshot", async () => {
    let controller: ReturnType<typeof useEditableRowVersionGrid>["controller"] | null = null;
    let resolveApply!: (value: AppliedChangeSet) => void;
    const pendingApply = new Promise<AppliedChangeSet>((resolve) => {
      resolveApply = resolve;
    });
    const client = makeFakeClient(() => pendingApply);
    const schema: Schema = {
      app_id: "hc",
      customer_id: "demo",
      version: "1",
      models: [
        {
          id: "employee",
          kind: "entity",
          label: "Employee",
          fields: [{ id: "title", label: "Name", type: "text", required: true }],
        },
      ],
      custom_fields: [
        {
          id: "employee_level_definition",
          model_id: "employee",
          field_id: "employee_level",
          label: "Employee level",
          type: "text",
        },
      ],
      change_types: [],
    };

    function AtomicSaveHarness() {
      ({ controller } = useEditableRowVersionGrid({
        modelId: "employee",
        asOf: "2026-05-13",
        scope: { appId: "hc", customerId: "demo" },
        rows: [],
        client,
        changeTypeId: "employee_update",
        transformWrites: (writes) => splitCustomFieldsFromWrites(writes, schema),
        ...testSchemaConfig(),
      }));
      return null;
    }

    render(<AtomicSaveHarness />);
    act(() => {
      controller!.stageNewRecord(
        {
          title: { type: "text", value: "Sarah Chen" },
          employee_level: { type: "text", value: "L4" },
        },
        { newRecordId: "018f6bf3-1ea5-7812-9a5a-a1f5b04f0100" },
      );
    });

    let prepared: PreparedAtomicGridSave | null = null;
    let blockedSave!: Promise<SaveOutcome>;
    act(() => {
      prepared = controller!.prepareAtomicSave();
      blockedSave = controller!.save();
    });
    await expect(blockedSave).resolves.toEqual({
      savedStageCount: 0,
      remainingStageCount: 2,
      perChangeSet: [
        {
          changeTypeId: "employee_update",
          stageCount: 2,
          status: "blocked",
        },
      ],
    });
    const preparedSave = prepared as PreparedAtomicGridSave | null;
    if (!preparedSave) throw new Error("expected an atomic save snapshot");
    expect(preparedSave.writes).toEqual([
      expect.objectContaining({
        model_id: "employee",
        new_record_id: "018f6bf3-1ea5-7812-9a5a-a1f5b04f0100",
        values: { title: { type: "text", value: "Sarah Chen" } },
        custom_fields: [{ field_id: "employee_level", type: "text", value: "L4" }],
      }),
    ]);
    expect(controller!.submitting).toBe(true);

    let attemptedDuringSave: { tempRowKey: string } | undefined;
    act(() => {
      attemptedDuringSave = controller!.stageNewRecord({
        title: { type: "text", value: "Must not stage" },
      });
    });
    expect(attemptedDuringSave).toEqual({ tempRowKey: "" });
    expect(controller!.dirtyCount).toBe(2);

    expect(client.postJson).not.toHaveBeenCalled();

    act(() => preparedSave.acknowledge());
    expect(controller!.dirtyCount).toBe(0);
    expect(controller!.submitting).toBe(false);
    expect(() => preparedSave.acknowledge()).not.toThrow();

    let cleanPrepared: PreparedAtomicGridSave | null = null;
    act(() => {
      cleanPrepared = controller!.prepareAtomicSave();
    });
    const cleanSave = cleanPrepared as PreparedAtomicGridSave | null;
    if (!cleanSave) throw new Error("expected a clean grid lock");
    expect(cleanSave.writes).toEqual([]);
    expect(cleanSave.stageCount).toBe(0);
    expect(controller!.submitting).toBe(true);
    act(() => cleanSave.cancel());
    expect(controller!.submitting).toBe(false);

    act(() => {
      controller!.stageNewRecord({
        title: { type: "text", value: "Second record" },
        employee_level: { type: "text", value: "L5" },
      });
    });
    let ordinarySave!: Promise<SaveOutcome>;
    act(() => {
      ordinarySave = controller!.save();
    });
    expect(() => controller!.prepareAtomicSave()).toThrow(/save is already in flight/i);
    resolveApply({ id: 2, schema_revision_id: "1" });
    await act(async () => {
      await ordinarySave;
    });
    expect(client.postJson).toHaveBeenCalledWith(
      "/api/apply",
      expect.objectContaining({
        writes: [
          expect.objectContaining({
            values: { title: { type: "text", value: "Second record" } },
            custom_fields: [{ field_id: "employee_level", type: "text", value: "L5" }],
          }),
        ],
      }),
    );
  });

  it("threads caller-provided idempotency keys into grid save payloads", async () => {
    const user = userEvent.setup();
    const client = makeFakeClient();

    function IdempotentSaveHarness() {
      const { controller } = useEditableRowVersionGrid({
        modelId: "position",
        asOf: "2026-05-13",
        scope: { appId: "hc", customerId: "demo" },
        rows: [],
        client,
        changeTypeId: "position_update",
        idempotencyKeyForChangeType: (changeTypeId) => `import-run-1:${changeTypeId}`,
        ...testSchemaConfig(),
      });
      return (
        <div>
          <button
            data-testid="stage-new"
            onClick={() => {
              controller.stageNewRecord({
                title: { type: "text", value: "Brand New Position" },
              });
            }}
          >
            stage
          </button>
          <button data-testid="save" onClick={() => void controller.save()}>
            save
          </button>
        </div>
      );
    }

    render(<IdempotentSaveHarness />);
    await user.click(screen.getByTestId("stage-new"));
    await user.click(screen.getByTestId("save"));

    expect(client.postJson).toHaveBeenCalledTimes(1);
    const payload = client.postJson.mock.calls[0]![1] as ApplyChangeSet;
    expect(payload.idempotency_key).toBe("import-run-1:position_update");
  });

  it("stage-then-edit-then-save: editing a cell on the staged draft preserves new-record semantics", async () => {
    // Reproduces the regression flagged by external review: after
    // `stageNewRecord`, the user edits a cell on the visible draft row.
    // The cell setter previously stamped meta.recordKey =
    // { type: "record_id", value: "tmp:..." } unconditionally, which
    // entriesToWrites then emitted on the wire as
    // `record_key: { type: "record_id", value: "tmp:..." }` — the kernel
    // would treat that as an update to a non-existent record.
    //
    // Fix: the cell setters detect the `tmp:` rowKey prefix and pass
    // `recordKey: undefined` so meta stays consistent across stage + edit.
    // This test asserts the fix end-to-end through the public hook
    // surface; failing it means the bug regressed.

    const user = userEvent.setup();
    const client = makeFakeClient();
    const newRecordId = "018f6bf3-1ea5-7812-9a5a-a1f5b04f0100";

    type Captured = {
      stageNewRecord: (values: Record<string, { type: "text"; value: string }>) => {
        tempRowKey: string;
      };
      save: ReturnType<typeof useEditableRowVersionGrid>["controller"]["save"];
      newRowDrafts: VisibleRecord[];
      fieldSetter: (
        fieldId: string,
        fieldType: "text",
      ) => (params: { data?: VisibleRecord; newValue: unknown }) => boolean;
    };
    let captured: Captured | null = null;

    function Harness() {
      const ctxRef = useRef<{
        fieldSetter: Captured["fieldSetter"];
      } | null>(null);
      const { controller, surfaceProps } = useEditableRowVersionGrid({
        modelId: "position",
        asOf: "2026-05-13",
        scope: { appId: "hc", customerId: "demo" },
        rows: [],
        client,
        // Save-time guardrail (fix #3): supply a resolution path.
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
          captured = {
            stageNewRecord: controller.stageNewRecord as Captured["stageNewRecord"],
            save: controller.save,
            newRowDrafts: controller.newRowDrafts,
            fieldSetter: fieldSetterFromSurface(surfaceProps),
          };
        }
      });
      return (
        <div>
          <button
            data-testid="stage"
            onClick={() => {
              controller.stageNewRecord(
                {
                  title: { type: "text", value: "Initial" },
                  level: { type: "text", value: "L4" },
                },
                { newRecordId },
              );
            }}
          >
            stage
          </button>
          <button data-testid="save" onClick={() => void controller.save()}>
            save
          </button>
        </div>
      );
    }

    render(<Harness />);

    // Stage a new draft.
    await user.click(screen.getByTestId("stage"));
    expect(captured).not.toBeNull();
    const draft = captured!.newRowDrafts[0]!;
    expect(draft.record_id).toMatch(/^tmp:/);

    // Now simulate the user editing the staged draft's `title` cell via
    // the grid's setter — same path AG Grid would invoke when the user
    // commits a cell edit on the draft row.
    const setter = captured!.fieldSetter("title", "text");
    act(() => {
      setter({
        data: draft,
        newValue: "Edited After Stage",
      });
    });

    // Save and assert wire shape.
    await user.click(screen.getByTestId("save"));

    expect(client.postJson).toHaveBeenCalledTimes(1);
    const payload = (client.postJson as ReturnType<typeof vi.fn>).mock
      .calls[0]![1] as ApplyChangeSet;
    expect(payload.writes).toHaveLength(1);
    const write = payload.writes[0]!;

    // CRITICAL: record_key must STILL be absent — even after the
    // post-stage cell edit. If the bug regresses, write.record_key would
    // be `{ type: "record_id", value: "tmp:..." }` and this assertion
    // would fail. The kernel would otherwise interpret the wire payload
    // as an update to a non-existent `tmp:...` record_id and reject it.
    expect(Object.prototype.hasOwnProperty.call(write, "record_key")).toBe(false);
    expect(write.new_record_id).toBe(newRecordId);

    // The edit MUST land in the values map — confirms the cell setter ran
    // and updated the draft's title field, just without the bad recordKey.
    expect(write.values).toBeDefined();
    expect(write.values!.title).toEqual({ type: "text", value: "Edited After Stage" });
    expect(write.values!.level).toEqual({ type: "text", value: "L4" });
  });

  it("renders draft rows whose non-text field is seeded empty-with-invalid (failed derivation shape)", async () => {
    // Import previews stage a failed derived REQUIRED field as an empty
    // text value plus a seeded invalid cell — including on NON-text targets
    // (date/money). The draft row must render (buffer entry exists) and the
    // invalid cell must gate the row until the user supplies a real value
    // through the column's typed editor.
    const user = userEvent.setup();
    const client = makeFakeClient();

    type Captured = {
      controller: ReturnType<typeof useEditableRowVersionGrid>["controller"];
    };
    let captured: Captured | null = null;

    function Harness() {
      const { controller } = useEditableRowVersionGrid({
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
      return (
        <button
          data-testid="stage"
          onClick={() => {
            controller.stageNewRecord(
              {
                title: { type: "text", value: "Derived Row" },
                // Non-text target (date) seeded as empty text — the failed
                // derivation shape.
                start_date: { type: "text", value: "" },
              },
              {
                tempRowKey: "tmp:derived-failed-1",
                initialInvalidCells: {
                  start_date: "Derivation failed; supply a value",
                },
              },
            );
          }}
        >
          stage
        </button>
      );
    }

    render(<Harness />);
    await user.click(screen.getByTestId("stage"));

    expect(captured!.controller.newRowDrafts).toHaveLength(1);
    expect(captured!.controller.newRowDrafts[0]?.record_id).toBe("tmp:derived-failed-1");
    expect(captured!.controller.invalidCellCount).toBe(1);
    expect(captured!.controller.invalidRowCount).toBe(1);
  });

  it("stageBulkUpdate clears seeded invalid cells on explicit clean restage", async () => {
    const client = makeFakeClient();
    const row: VisibleRecord = {
      record_id: "rec-1",
      effective_start: "2026-05-13",
      effective_end: null,
      custom_fields: [],
      values: {
        title: { type: "text", value: "Original Title" },
        start_date: { type: "date", value: "2026-05-13" },
      },
    };

    type Captured = {
      controller: ReturnType<typeof useEditableRowVersionGrid>["controller"];
    };
    let captured: Captured | null = null;

    function Harness() {
      const { controller } = useEditableRowVersionGrid({
        modelId: "position",
        asOf: "2026-05-13",
        scope: { appId: "hc", customerId: "demo" },
        rows: [row],
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
      const result = captured!.controller.stageBulkUpdate({
        rows: [{ rowKey: "rec-1" }],
        values: { title: { type: "text", value: "Imported Title" } },
        bulkGroupId: "preview-1",
        initialInvalidCells: {
          start_date: "Derivation failed; supply a value",
        },
      });
      expect(result.ok).toBe(true);
    });
    expect(captured!.controller.invalidCellCount).toBe(1);

    act(() => {
      const result = captured!.controller.stageBulkUpdate({
        rows: [{ rowKey: "rec-1" }],
        values: {},
        bulkGroupId: "preview-2",
        initialInvalidCells: undefined,
      });
      expect(result.ok).toBe(true);
    });
    expect(captured!.controller.invalidCellCount).toBe(0);

    let outcome!: SaveOutcome;
    await act(async () => {
      outcome = await captured!.controller.save();
    });
    expect(outcome.savedStageCount).toBe(1);
    expect(client.postJson).toHaveBeenCalledTimes(1);
  });

  it("clears a seeded invalid cell when an existing row re-enters its current value", () => {
    const client = makeFakeClient();
    const row: VisibleRecord = {
      record_id: "rec-1",
      effective_start: "2026-05-13",
      effective_end: null,
      custom_fields: [],
      values: {
        title: { type: "text", value: "Original Title" },
      },
    };

    type Captured = {
      controller: ReturnType<typeof useEditableRowVersionGrid>["controller"];
      fieldSetter: (
        fieldId: string,
        fieldType: "text",
      ) => (params: { data?: VisibleRecord; newValue: unknown }) => boolean;
    };
    let captured: Captured | null = null;

    function Harness() {
      const { controller, surfaceProps } = useEditableRowVersionGrid({
        modelId: "position",
        asOf: "2026-05-13",
        scope: { appId: "hc", customerId: "demo" },
        rows: [row],
        client,
        changeTypeId: "position_update",
        ...testSchemaConfig(),
      });
      useEffect(() => {
        captured = {
          controller,
          fieldSetter: fieldSetterFromSurface(surfaceProps),
        };
      });
      return null;
    }

    render(<Harness />);
    expect(captured).not.toBeNull();

    act(() => {
      const result = captured!.controller.stageBulkUpdate({
        rows: [{ rowKey: "rec-1" }],
        values: {},
        bulkGroupId: "preview-1",
        initialInvalidCells: {
          title: "Derivation failed; confirm the existing title",
        },
      });
      expect(result.ok).toBe(true);
    });
    expect(captured!.controller.invalidCellCount).toBe(1);

    const titleSetter = captured!.fieldSetter("title", "text");
    let changed!: boolean;
    act(() => {
      changed = titleSetter({ data: row, newValue: "Original Title" });
    });

    expect(changed).toBe(false);
    expect(captured!.controller.invalidCellCount).toBe(0);
    expect(captured!.controller.pendingChangesByRow.size).toBe(0);
  });

  it("stage-then-edit-then-save: import draft rows preserve caller-provided record keys", async () => {
    const user = userEvent.setup();
    const client = makeFakeClient();

    type Captured = {
      newRowDrafts: VisibleRecord[];
      fieldSetter: (
        fieldId: string,
        fieldType: "text",
      ) => (params: { data?: VisibleRecord; newValue: unknown }) => boolean;
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
        captured = {
          newRowDrafts: controller.newRowDrafts,
          fieldSetter: fieldSetterFromSurface(surfaceProps),
        };
      });
      return (
        <div>
          <button
            data-testid="stage"
            onClick={() => {
              controller.stageNewRecord(
                {
                  title: { type: "text", value: "Initial" },
                  level: { type: "text", value: "L4" },
                },
                {
                  recordKey: { type: "external_key", value: "imp-position-1" },
                },
              );
            }}
          >
            stage
          </button>
          <button data-testid="save" onClick={() => void controller.save()}>
            save
          </button>
        </div>
      );
    }

    render(<Harness />);

    await user.click(screen.getByTestId("stage"));
    const draft = captured!.newRowDrafts[0]!;
    const setter = captured!.fieldSetter("title", "text");
    act(() => {
      setter({
        data: draft,
        newValue: "Edited After Stage",
      });
    });
    await user.click(screen.getByTestId("save"));

    expect(client.postJson).toHaveBeenCalledTimes(1);
    const payload = client.postJson.mock.calls[0]![1] as ApplyChangeSet;
    expect(payload.writes).toHaveLength(1);
    const write = payload.writes[0]!;
    expect(write.record_key).toEqual({ type: "external_key", value: "imp-position-1" });
    expect(write.values!.title).toEqual({ type: "text", value: "Edited After Stage" });
  });

  it("stage-then-asof-change-then-edit: draft row edits stay anchored to the staging effective_start", async () => {
    const user = userEvent.setup();
    const client = makeFakeClient();

    type Captured = {
      stageNewRecord: (values: Record<string, { type: "text"; value: string }>) => {
        tempRowKey: string;
      };
      save: ReturnType<typeof useEditableRowVersionGrid>["controller"]["save"];
      newRowDrafts: VisibleRecord[];
      fieldSetter: (
        fieldId: string,
        fieldType: "text",
      ) => (params: { data?: VisibleRecord; newValue: unknown }) => boolean;
    };
    let captured: Captured | null = null;

    function Harness() {
      const [asOf, setAsOf] = useState("2026-05-13");
      const ctxRef = useRef<{
        fieldSetter: Captured["fieldSetter"];
      } | null>(null);
      const { controller, surfaceProps } = useEditableRowVersionGrid({
        modelId: "position",
        asOf,
        scope: { appId: "hc", customerId: "demo" },
        rows: [],
        client,
        // Save-time guardrail (fix #3): supply a resolution path.
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
          captured = {
            stageNewRecord: controller.stageNewRecord as Captured["stageNewRecord"],
            save: controller.save,
            newRowDrafts: controller.newRowDrafts,
            fieldSetter: fieldSetterFromSurface(surfaceProps),
          };
        }
      });
      return (
        <div>
          <button
            data-testid="stage"
            onClick={() => {
              controller.stageNewRecord({
                title: { type: "text", value: "Initial" },
                level: { type: "text", value: "L4" },
              });
            }}
          >
            stage
          </button>
          <button data-testid="advance-asof" onClick={() => setAsOf("2026-06-01")}>
            advance asof
          </button>
          <button data-testid="save" onClick={() => void controller.save()}>
            save
          </button>
        </div>
      );
    }

    render(<Harness />);

    await user.click(screen.getByTestId("stage"));
    expect(captured).not.toBeNull();
    const draft = captured!.newRowDrafts[0]!;
    expect(draft.record_id).toMatch(/^tmp:/);

    await user.click(screen.getByTestId("advance-asof"));

    const setter = captured!.fieldSetter("title", "text");
    act(() => {
      setter({
        data: draft,
        newValue: "Edited After AsOf Change",
      });
    });

    await user.click(screen.getByTestId("save"));

    expect(client.postJson).toHaveBeenCalledTimes(1);
    const payload = (client.postJson as ReturnType<typeof vi.fn>).mock
      .calls[0]![1] as ApplyChangeSet;
    expect(payload.writes).toHaveLength(1);
    const write = payload.writes[0]!;

    expect(write.effective_start).toBe("2026-05-13");
    expect(Object.prototype.hasOwnProperty.call(write, "record_key")).toBe(false);
    expect(write.values).toEqual({
      title: { type: "text", value: "Edited After AsOf Change" },
      level: { type: "text", value: "L4" },
    });
  });

  it("sibling commit clears stale cross-field invalid cell from the same row", async () => {
    // Repro of the review-flagged staleness:
    //   1. Row has start_date=2026-05-10, end_date=2026-05-15.
    //   2. User attempts start_date=2026-05-20 → dateBefore({ endFieldId:
    //      "end_date" }) rejects (start > end). invalidCells gains
    //      `${rec}::start_date`. params.data.values.start_date stays at
    //      2026-05-10 because the rejection short-circuits the row mutation.
    //   3. User commits end_date=2026-05-25 → dateAfter passes, end_date
    //      buffer entry created, end_date's own invalidKey cleared (it was
    //      never set anyway).
    //   4. Without sibling re-evaluation, start_date stays red even though
    //      its CURRENT (un-mutated) value 2026-05-10 is now valid relative
    //      to the new end_date 2026-05-25 — a false-positive error the user
    //      can only clear by re-editing+re-committing start_date.
    //   5. With the validator-registry fix, the successful end_date commit
    //      walks invalidCells for the same row, re-runs each sibling's
    //      registered validator against the post-mutation row state, and
    //      evicts any that now pass — start_date's stale red disappears.
    //
    // Failure mode if regressed: the final assertion below flips to true
    // because the rule still resolves to invalidCells.has("rec-1::start_date")
    // even though the underlying constraint no longer binds.

    const client = makeFakeClient();

    const row: VisibleRecord = {
      record_id: "rec-1",
      effective_start: "2026-05-13",
      effective_end: null,
      custom_fields: [],
      values: {
        start_date: { type: "date", value: "2026-05-10" },
        end_date: { type: "date", value: "2026-05-15" },
      },
    };

    type CapturedSetter = (
      fieldId: string,
      type: "date",
      options?: { validate?: FieldValidator },
    ) => (params: { data?: VisibleRecord; newValue: unknown }) => boolean;
    type InvalidRule = (params: {
      data?: VisibleRecord;
      colDef: { colId?: string; field?: string };
    }) => boolean;
    type Captured = {
      fieldSetter: CapturedSetter;
      // Captured rule reference; recreated each render when invalidCells
      // changes (useMemo dep). Test re-reads `captured.invalidRule` after
      // each setter call so it sees the latest invalidCells snapshot.
      invalidRule: InvalidRule | undefined;
    };
    let captured: Captured | null = null;

    function Harness() {
      const ctxRef = useRef<Captured | null>(null);
      const { surfaceProps } = useEditableRowVersionGrid({
        modelId: "position",
        asOf: "2026-05-13",
        scope: { appId: "hc", customerId: "demo" },
        rows: [row],
        client,
        ...testSchemaConfig(),
        fieldOverrides: {
          start_date: { validate: dateBefore({ endFieldId: "end_date" }) },
          end_date: { validate: dateAfter({ startFieldId: "start_date" }) },
        },
      });
      useEffect(() => {
        ctxRef.current = {
          ...((ctxRef.current ?? {}) as object),
          fieldSetter: fieldSetterFromSurface(surfaceProps),
          invalidRule: invalidRuleFromSurface(surfaceProps),
        } as never;
        if (ctxRef.current) {
          captured = ctxRef.current;
        }
      });
      return null;
    }

    render(<Harness />);
    expect(captured).not.toBeNull();

    // Build setters with cross-field validators wired (mirrors PositionsPage
    // start_date / end_date column config — same factory call shape, same
    // validator pair, so the registry sees both fields' validators after
    // these factory calls).
    const startSetter = captured!.fieldSetter("start_date", "date", {
      validate: dateBefore({ endFieldId: "end_date" }),
    });
    const endSetter = captured!.fieldSetter("end_date", "date", {
      validate: dateAfter({ startFieldId: "start_date" }),
    });

    // Step 1: invalid start_date commit → should be rejected.
    let result1!: boolean;
    act(() => {
      result1 = startSetter({ data: row, newValue: "2026-05-20" });
    });
    expect(result1).toBe(false);
    // Re-read latest rule (invalidCells changed, useMemo recomputed it).
    const ruleAfterStart = captured!.invalidRule;
    expect(typeof ruleAfterStart).toBe("function");
    expect(ruleAfterStart!({ data: row, colDef: { colId: "start_date" } })).toBe(true);
    expect(ruleAfterStart!({ data: row, colDef: { colId: "end_date" } })).toBe(false);

    // Step 2: commit end_date later → passes; sibling re-eval should drop
    // start_date's stale invalidKey.
    let result2!: boolean;
    act(() => {
      result2 = endSetter({ data: row, newValue: "2026-05-25" });
    });
    expect(result2).toBe(true);

    // Re-read the rule (recreated again since invalidCells changed twice).
    const ruleAfterEnd = captured!.invalidRule;
    expect(ruleAfterEnd!({ data: row, colDef: { colId: "start_date" } })).toBe(false);
    expect(ruleAfterEnd!({ data: row, colDef: { colId: "end_date" } })).toBe(false);
  });

  it("reverting a field to its saved value clears a stale sibling error", () => {
    const client = makeFakeClient();
    const row: VisibleRecord = {
      record_id: "rec-1",
      effective_start: "2026-05-13",
      effective_end: null,
      custom_fields: [],
      values: {
        start_date: { type: "date", value: "2026-05-10" },
        end_date: { type: "date", value: "2026-05-15" },
      },
    };
    type Setter = (
      fieldId: string,
      type: "date",
      options?: { validate?: FieldValidator },
    ) => (params: { data?: VisibleRecord; newValue: unknown }) => boolean;
    type InvalidRule = (params: {
      data?: VisibleRecord;
      colDef: { colId?: string; field?: string };
    }) => boolean;
    let captured: { fieldSetter: Setter; invalidRule: InvalidRule | undefined } | null = null;
    function Harness() {
      const { surfaceProps } = useEditableRowVersionGrid({
        modelId: "position",
        asOf: "2026-05-13",
        scope: { appId: "hc", customerId: "demo" },
        rows: [row],
        client,
        ...testSchemaConfig(),
        fieldOverrides: {
          start_date: { validate: dateBefore({ endFieldId: "end_date" }) },
          end_date: { validate: dateAfter({ startFieldId: "start_date" }) },
        },
      });
      useEffect(() => {
        captured = {
          fieldSetter: fieldSetterFromSurface(surfaceProps) as Setter,
          invalidRule: invalidRuleFromSurface(surfaceProps) as InvalidRule,
        };
      });
      return null;
    }
    render(<Harness />);
    // Setters from the latest render, so each sees the current buffer.
    const startSetter = (params: { data?: VisibleRecord; newValue: unknown }) =>
      captured!.fieldSetter("start_date", "date", {
        validate: dateBefore({ endFieldId: "end_date" }),
      })(params);
    const endSetter = (params: { data?: VisibleRecord; newValue: unknown }) =>
      captured!.fieldSetter("end_date", "date", {
        validate: dateAfter({ startFieldId: "start_date" }),
      })(params);

    // Extend end_date, then commit a start_date past even the extended end:
    // it is rejected and start_date is flagged.
    act(() => {
      expect(endSetter({ data: row, newValue: "2026-05-25" })).toBe(true);
    });
    act(() => {
      expect(startSetter({ data: row, newValue: "2026-05-30" })).toBe(false);
    });
    expect(captured!.invalidRule!({ data: row, colDef: { colId: "start_date" } })).toBe(true);

    // Reverting end_date to its saved value re-checks start_date (still
    // 2026-05-10, valid against 2026-05-15), so the stale error clears.
    act(() => {
      expect(endSetter({ data: row, newValue: "2026-05-15" })).toBe(true);
    });
    expect(captured!.invalidRule!({ data: row, colDef: { colId: "start_date" } })).toBe(false);
  });

  it("stageBulkUpdate validates a staged new row against its draft values", () => {
    const client = makeFakeClient();
    let captured: {
      controller: ReturnType<typeof useEditableRowVersionGrid>["controller"];
    } | null = null;
    function Harness() {
      const { controller } = useEditableRowVersionGrid({
        modelId: "position",
        asOf: "2026-05-13",
        scope: { appId: "hc", customerId: "demo" },
        rows: [],
        client,
        ...testSchemaConfig(),
        fieldOverrides: { start_date: { validate: dateBefore({ endFieldId: "end_date" }) } },
      });
      useEffect(() => {
        captured = { controller };
      });
      return null;
    }
    render(<Harness />);

    let tempRowKey = "";
    act(() => {
      tempRowKey = captured!.controller.stageNewRecord({
        end_date: { type: "date", value: "2026-05-15" },
      }).tempRowKey;
    });

    // A start after the draft's own end is refused, as the cell setter would.
    let result!: StageBulkUpdateResult;
    act(() => {
      result = captured!.controller.stageBulkUpdate({
        rows: [{ rowKey: tempRowKey }],
        fieldId: "start_date",
        value: { type: "date", value: "2026-05-30" },
        bulkGroupId: "bulk-1",
      });
    });
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.failures.map((failure) => failure.fieldId)).toEqual([
      "start_date",
    ]);

    // A start before it stages.
    act(() => {
      result = captured!.controller.stageBulkUpdate({
        rows: [{ rowKey: tempRowKey }],
        fieldId: "start_date",
        value: { type: "date", value: "2026-05-10" },
        bulkGroupId: "bulk-2",
      });
    });
    expect(result.ok).toBe(true);
  });

  describe("stageBulkUpdate validates the row as the whole update leaves it", () => {
    const saved: VisibleRecord = {
      record_id: "rec-1",
      effective_start: "2026-05-13",
      effective_end: null,
      custom_fields: [],
      values: {
        start_date: { type: "date", value: "2026-05-10" },
        end_date: { type: "date", value: "2026-05-15" },
      },
    };
    function mount() {
      const captured: {
        controller?: ReturnType<typeof useEditableRowVersionGrid>["controller"];
      } = {};
      function Harness() {
        const { controller } = useEditableRowVersionGrid({
          modelId: "position",
          asOf: "2026-05-13",
          scope: { appId: "hc", customerId: "demo" },
          rows: [saved],
          client: makeFakeClient(),
          ...testSchemaConfig(),
          fieldOverrides: {
            start_date: { validate: dateBefore({ endFieldId: "end_date" }) },
            end_date: { validate: dateAfter({ startFieldId: "start_date" }) },
          },
        });
        useEffect(() => {
          captured.controller = controller;
        });
        return null;
      }
      render(<Harness />);
      return () => captured.controller!;
    }
    const moveDates = (
      controller: ReturnType<typeof useEditableRowVersionGrid>["controller"],
      rowKey: string,
      start: string,
      end: string,
    ) =>
      controller.stageBulkUpdate({
        rows: [{ rowKey }],
        values: {
          start_date: { type: "date", value: start },
          end_date: { type: "date", value: end },
        },
        bulkGroupId: `move-${start}-${end}`,
      });

    it("on a saved row", () => {
      const controller = mount();
      let result!: StageBulkUpdateResult;
      // Both dates move past the saved end together: valid as a whole.
      act(() => {
        result = moveDates(controller(), "rec-1", "2026-05-20", "2026-05-30");
      });
      expect(result.ok).toBe(true);
      act(() => {
        result = moveDates(controller(), "rec-1", "2026-05-20", "2026-05-18");
      });
      expect(result.ok).toBe(false);
    });

    it("on a staged new row", () => {
      const controller = mount();
      let tempRowKey = "";
      act(() => {
        tempRowKey = controller().stageNewRecord({
          start_date: { type: "date", value: "2026-05-10" },
          end_date: { type: "date", value: "2026-05-15" },
        }).tempRowKey;
      });
      let result!: StageBulkUpdateResult;
      act(() => {
        result = moveDates(controller(), tempRowKey, "2026-05-20", "2026-05-30");
      });
      expect(result.ok).toBe(true);
      act(() => {
        result = moveDates(controller(), tempRowKey, "2026-05-20", "2026-05-18");
      });
      expect(result.ok).toBe(false);
    });

    it("on a row staged earlier in the same tick", () => {
      const controller = mount();
      let result!: StageBulkUpdateResult;
      act(() => {
        const { tempRowKey } = controller().stageNewRecord({
          end_date: { type: "date", value: "2026-05-15" },
        });
        result = controller().stageBulkUpdate({
          rows: [{ rowKey: tempRowKey }],
          fieldId: "start_date",
          value: { type: "date", value: "2026-05-30" },
          bulkGroupId: "same-tick",
        });
      });
      expect(result.ok).toBe(false);
    });

    it("stages what it validated on a row staged earlier in the same tick", () => {
      const captured: {
        controller?: ReturnType<typeof useEditableRowVersionGrid>["controller"];
      } = {};
      function Harness() {
        const { controller } = useEditableRowVersionGrid({
          modelId: "position",
          asOf: "2026-05-13",
          scope: { appId: "hc", customerId: "demo" },
          rows: [],
          client: makeFakeClient(),
          ...testSchemaConfig(),
          fieldOverrides: {
            start_date: { validate: dateBefore({ endFieldId: "end_date" }) },
            end_date: { validate: dateAfter({ startFieldId: "start_date" }) },
          },
        });
        useEffect(() => {
          captured.controller = controller;
        });
        return null;
      }
      render(<Harness />);
      let result!: StageBulkUpdateResult;
      let tempRowKey = "";
      act(() => {
        tempRowKey = captured.controller!.stageNewRecord(
          { end_date: { type: "date", value: "2026-05-15" } },
          { effectiveStart: "2026-04-01" },
        ).tempRowKey;
        // Valid only because the end is cleared, so the clear must stage too.
        result = captured.controller!.stageBulkUpdate({
          rows: [{ rowKey: tempRowKey }],
          values: { start_date: { type: "date", value: "2026-05-30" }, end_date: null },
          bulkGroupId: "same-tick-clear",
        });
      });
      expect(result.ok).toBe(true);
      const draft = captured.controller!.newRowDrafts.find((row) => row.record_id === tempRowKey);
      expect(draft?.values).toEqual({ start_date: { type: "date", value: "2026-05-30" } });
      // The draft keeps the date it was staged at.
      expect(draft?.effective_start).toBe("2026-04-01");
    });
  });

  it("sibling commit does not clear seeded import-review invalid cells", async () => {
    const user = userEvent.setup();
    const client = makeFakeClient();

    type Captured = {
      controller: ReturnType<typeof useEditableRowVersionGrid>["controller"];
      fieldSetter: (
        fieldId: string,
        type: "date",
        options?: { validate?: FieldValidator },
      ) => (params: { data?: VisibleRecord; newValue: unknown }) => boolean;
      invalidRule: ReturnType<typeof invalidRuleFromSurface>;
    };
    let captured: Captured | null = null;

    function Harness() {
      const ctxRef = useRef<Captured | null>(null);
      const { controller, surfaceProps } = useEditableRowVersionGrid({
        modelId: "position",
        asOf: "2026-05-13",
        scope: { appId: "hc", customerId: "demo" },
        rows: [],
        client,
        changeTypeId: "position_update",
        ...testSchemaConfig(),
        fieldOverrides: {
          start_date: { validate: dateBefore({ endFieldId: "end_date" }) },
          end_date: { validate: dateAfter({ startFieldId: "start_date" }) },
        },
      });
      useEffect(() => {
        ctxRef.current = {
          controller,
          fieldSetter: fieldSetterFromSurface(surfaceProps),
          invalidRule: invalidRuleFromSurface(surfaceProps),
        };
        captured = ctxRef.current;
      });
      return (
        <button
          data-testid="stage"
          onClick={() => {
            controller.stageNewRecord(
              {
                title: { type: "text", value: "Derived Row" },
                start_date: { type: "text", value: "" },
                end_date: { type: "date", value: "2026-05-25" },
              },
              {
                tempRowKey: "tmp:derived-failed-1",
                initialInvalidCells: {
                  start_date: "Derivation failed; supply a value",
                },
              },
            );
          }}
        >
          stage
        </button>
      );
    }

    render(<Harness />);
    await user.click(screen.getByTestId("stage"));

    const draft = captured!.controller.newRowDrafts[0]!;
    expect(captured!.controller.invalidCellCount).toBe(1);
    expect(captured!.controller.invalidRowCount).toBe(1);
    expect(captured!.invalidRule!({ data: draft, colDef: { colId: "start_date" } })).toBe(true);

    const startSetter = captured!.fieldSetter("start_date", "date", {
      validate: dateBefore({ endFieldId: "end_date" }),
    });
    const endSetter = captured!.fieldSetter("end_date", "date", {
      validate: dateAfter({ startFieldId: "start_date" }),
    });
    expect(typeof startSetter).toBe("function");

    let result!: boolean;
    act(() => {
      result = endSetter({ data: draft, newValue: "2026-06-01" });
    });

    expect(result).toBe(true);
    expect(captured!.controller.invalidCellCount).toBe(1);
    expect(captured!.controller.invalidRowCount).toBe(1);
    expect(captured!.invalidRule!({ data: draft, colDef: { colId: "start_date" } })).toBe(true);

    const outcome = await captured!.controller.save();
    expect(outcome.savedStageCount).toBe(0);
    expect(client.postJson).not.toHaveBeenCalled();
  });

  it("save success preserves cells edited DURING the in-flight apply", async () => {
    // Repro of the Devin-flagged regression:
    //   1. User edits cell A → buffer.cellCount == 1
    //   2. User clicks Save → apply() goes in flight
    //   3. While apply is hanging, user edits cell B → buffer.cellCount == 2
    //   4. Apply resolves successfully.
    //   5. The OLD save path called `clear()` here, wiping BOTH A and B.
    //      Cell B's edit is silently destroyed even though it was never
    //      submitted to the kernel — pure data loss.
    //   6. The fixed save path snapshots the buffer BEFORE apply, then
    //      uses `revertMatching(snapshot)` on success — only the submitted
    //      addresses (A) get reverted; mid-flight additions (B) survive.
    //
    // Failure mode if regressed: the final cellCount assertion drops to 0
    // (clear() wiped B) instead of 1 (revertMatching preserved B).

    const user = userEvent.setup();
    let resolveApply: ((value: AppliedChangeSet) => void) | null = null;
    const client = makeFakeClient(
      () =>
        new Promise<AppliedChangeSet>((resolve) => {
          resolveApply = resolve;
        }),
    );

    type Controller = ReturnType<typeof useEditableRowVersionGrid>["controller"];
    type CapturedSetter = (
      fieldId: string,
      type: "text",
    ) => (params: { data?: VisibleRecord; newValue: unknown }) => boolean;
    type Captured = {
      controller: Controller;
      fieldSetter: CapturedSetter;
    };
    let captured: Captured | null = null;

    const rowA: VisibleRecord = {
      record_id: "rec-A",
      effective_start: "2026-05-13",
      effective_end: null,
      custom_fields: [],
      values: { title: { type: "text", value: "Original A" } },
    };
    const rowB: VisibleRecord = {
      record_id: "rec-B",
      effective_start: "2026-05-13",
      effective_end: null,
      custom_fields: [],
      values: { title: { type: "text", value: "Original B" } },
    };

    function Harness() {
      const ctxRef = useRef<{ fieldSetter: CapturedSetter } | null>(null);
      const { controller, surfaceProps } = useEditableRowVersionGrid({
        modelId: "position",
        asOf: "2026-05-13",
        scope: { appId: "hc", customerId: "demo" },
        rows: [rowA, rowB],
        client,
        // Save-time guardrail (fix #3): supply a resolution path.
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

    // Step 1: edit cell A.
    const setter = captured!.fieldSetter("title", "text");
    act(() => {
      setter({ data: rowA, newValue: "Edited A" });
    });
    expect(captured!.controller.dirtyCount).toBe(1);

    // Step 2: kick off save (apply hangs because resolveApply isn't called).
    let savePromise!: Promise<unknown>;
    act(() => {
      savePromise = captured!.controller.save();
    });

    // Step 3: while apply is in flight, edit cell B.
    act(() => {
      setter({ data: rowB, newValue: "Mid-Flight B" });
    });
    expect(captured!.controller.dirtyCount).toBe(2);

    // Step 4: resolve the apply. Then await the save promise so the
    // success callback (revertMatching) runs before we assert.
    expect(resolveApply).not.toBeNull();
    await act(async () => {
      resolveApply!({ id: 1, schema_revision_id: "1" });
      await savePromise;
    });

    // Step 5: cell B MUST survive. The submitted snapshot only contained
    // cell A, so revertMatching reverts only A; B stays in the buffer
    // ready for the next save.
    expect(captured!.controller.dirtyCount).toBe(1);
  });

  it("pendingChangesByRow materializes one entry per dirtied row with inferred change_type + bulkGroupId", async () => {
    // Exercises the controller's `pendingChangesByRow` digest: each
    // dirtied row gets one summary, the change_type comes from the
    // app-supplied `inferChangeType` callback against the union of
    // touched field ids on that row, and `bulkGroupId` flows through
    // from `controller.stageBulkUpdate(...)` so the row-meta strip can
    // route the bulk variant.
    //
    // The hook also surfaces fieldChanges with prior captured at the
    // moment the cell setter committed (or, for `stageBulkUpdate`, from
    // the row data the page passed in).

    const client = makeFakeClient();

    // App's inference: any touch of "title" or "level" → "title_change";
    // any touch of "is_open" alone → "close_positions"; otherwise
    // "position_update" (the catch-all). Mirrors the schema-driven
    // inference the page builds in production.
    const inferChangeType = (touched: string[]) => {
      const set = new Set(touched);
      if ((set.has("title") || set.has("level")) && !set.has("is_open")) {
        return "title_change";
      }
      if (set.size === 1 && set.has("is_open")) return "close_positions";
      return "position_update";
    };

    type Captured = {
      controller: ReturnType<typeof useEditableRowVersionGrid>["controller"];
      fieldSetter: (
        fieldId: string,
        type: "text",
      ) => (params: { data?: VisibleRecord; newValue: unknown }) => boolean;
    };
    let captured: Captured | null = null;

    const rowA: VisibleRecord = {
      record_id: "rec-A",
      effective_start: "2026-05-13",
      effective_end: null,
      custom_fields: [],
      values: {
        title: { type: "text", value: "Old A Title" },
        is_open: { type: "bool", value: true },
      },
    };
    const rowB: VisibleRecord = {
      record_id: "rec-B",
      effective_start: "2026-05-13",
      effective_end: null,
      custom_fields: [],
      values: {
        title: { type: "text", value: "Old B Title" },
        is_open: { type: "bool", value: true },
      },
    };

    function Harness() {
      const ctxRef = useRef<{
        fieldSetter: Captured["fieldSetter"];
      } | null>(null);
      const { controller, surfaceProps } = useEditableRowVersionGrid({
        modelId: "position",
        asOf: "2026-05-13",
        scope: { appId: "hc", customerId: "demo" },
        rows: [rowA, rowB],
        client,
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
    // Initial: no pending edits.
    expect(captured!.controller.pendingChangesByRow.size).toBe(0);

    // Edit rowA's title via the cell setter — exercises the human
    // projection path into the record-level buffer.
    const titleSetter = captured!.fieldSetter("title", "text");
    act(() => {
      titleSetter({ data: rowA, newValue: "New A Title" });
    });

    // Stage a bulk close on rowB via the bulk-update API — exercises
    // the bulkGroupId stamping path.
    act(() => {
      captured!.controller.stageBulkUpdate({
        rows: [{ rowKey: "rec-B" }],
        fieldId: "is_open",
        value: { type: "bool", value: false },
        bulkGroupId: "close-q1",
      });
    });

    // Two distinct rows in the digest; one summary each.
    expect(captured!.controller.pendingChangesByRow.size).toBe(2);

    const summaryA = captured!.controller.pendingChangesByRow.get("rec-A");
    expect(summaryA).toBeDefined();
    expect(summaryA!.changeType).toBe("title_change");
    expect(summaryA!.bulkGroupId).toBeUndefined();
    expect(summaryA!.fieldChanges).toHaveLength(1);
    expect(summaryA!.fieldChanges[0]!.fieldId).toBe("title");
    expect(summaryA!.fieldChanges[0]!.prior).toEqual({
      type: "text",
      value: "Old A Title",
    });
    expect(summaryA!.fieldChanges[0]!.next).toEqual({
      type: "text",
      value: "New A Title",
    });

    const summaryB = captured!.controller.pendingChangesByRow.get("rec-B");
    expect(summaryB).toBeDefined();
    expect(summaryB!.changeType).toBe("close_positions");
    expect(summaryB!.bulkGroupId).toBe("close-q1");
    expect(summaryB!.fieldChanges).toHaveLength(1);
    expect(summaryB!.fieldChanges[0]!.fieldId).toBe("is_open");
    expect(summaryB!.fieldChanges[0]!.prior).toEqual({
      type: "bool",
      value: true,
    });
    expect(summaryB!.fieldChanges[0]!.next).toEqual({
      type: "bool",
      value: false,
    });
  });

  it("setBulkFilter + setShowChangesOnly together filter rows via doesExternalFilterPass", async () => {
    // Exercises both external-filter inputs in combination. Wiring:
    //   - rowA has a per-cell title edit (no bulk group).
    //   - rowB has a bulk-staged is_open edit under group "close-q1".
    //   - rowC is untouched.
    //
    // Filter behavior:
    //   - showChangesOnly OFF + no bulk: all rows pass.
    //   - showChangesOnly ON + no bulk: rowA + rowB pass; rowC fails.
    //   - showChangesOnly OFF + bulk = "close-q1": only rowB passes.
    //   - showChangesOnly ON + bulk = "close-q1": only rowB passes
    //     (intersection — rowA is dirty but doesn't share the group).
    //
    // The test exercises `surfaceProps.externalFilterPass` directly
    // against synthetic IRowNode shapes; it doesn't mount AG Grid.

    const client = makeFakeClient();

    type Captured = {
      controller: ReturnType<typeof useEditableRowVersionGrid>["controller"];
      surfaceProps: ReturnType<typeof useEditableRowVersionGrid>["surfaceProps"];
      fieldSetter: (
        fieldId: string,
        type: "text",
      ) => (params: { data?: VisibleRecord; newValue: unknown }) => boolean;
    };
    let captured: Captured | null = null;

    const rowA: VisibleRecord = {
      record_id: "rec-A",
      effective_start: "2026-05-13",
      effective_end: null,
      custom_fields: [],
      values: { title: { type: "text", value: "A" }, is_open: { type: "bool", value: true } },
    };
    const rowB: VisibleRecord = {
      record_id: "rec-B",
      effective_start: "2026-05-13",
      effective_end: null,
      custom_fields: [],
      values: { title: { type: "text", value: "B" }, is_open: { type: "bool", value: true } },
    };
    const rowC: VisibleRecord = {
      record_id: "rec-C",
      effective_start: "2026-05-13",
      effective_end: null,
      custom_fields: [],
      values: { title: { type: "text", value: "C" }, is_open: { type: "bool", value: true } },
    };

    function Harness() {
      const ctxRef = useRef<{
        fieldSetter: Captured["fieldSetter"];
      } | null>(null);
      const { controller, surfaceProps } = useEditableRowVersionGrid({
        modelId: "position",
        asOf: "2026-05-13",
        scope: { appId: "hc", customerId: "demo" },
        rows: [rowA, rowB, rowC],
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
          captured = {
            controller,
            surfaceProps,
            fieldSetter: fieldSetterFromSurface(surfaceProps),
          };
        }
      });
      return null;
    }

    render(<Harness />);
    expect(captured).not.toBeNull();

    // Stage edits.
    const titleSetter = captured!.fieldSetter("title", "text");
    act(() => {
      titleSetter({ data: rowA, newValue: "A edited" });
    });
    act(() => {
      captured!.controller.stageBulkUpdate({
        rows: [{ rowKey: "rec-B" }],
        fieldId: "is_open",
        value: { type: "bool", value: false },
        bulkGroupId: "close-q1",
      });
    });

    // Re-read the latest surface props (regenerated each render).
    const passOf = (rowId: string) =>
      captured!.surfaceProps.externalFilterPass({
        data: rowId === "rec-A" ? rowA : rowId === "rec-B" ? rowB : rowC,
      } as unknown as Parameters<
        NonNullable<typeof captured>["surfaceProps"]["externalFilterPass"]
      >[0]);

    // Initial: no filters → presence false, pass true everywhere.
    expect(captured!.surfaceProps.externalFilterPresent).toBe(false);
    expect(passOf("rec-A")).toBe(true);
    expect(passOf("rec-B")).toBe(true);
    expect(passOf("rec-C")).toBe(true);

    // showChangesOnly ON, no bulk.
    act(() => {
      captured!.controller.setShowChangesOnly(true);
    });
    expect(captured!.surfaceProps.externalFilterPresent).toBe(true);
    expect(passOf("rec-A")).toBe(true);
    expect(passOf("rec-B")).toBe(true);
    expect(passOf("rec-C")).toBe(false);

    // showChangesOnly OFF + bulk = "close-q1".
    act(() => {
      captured!.controller.setShowChangesOnly(false);
      captured!.controller.setBulkFilter("close-q1");
    });
    expect(captured!.surfaceProps.externalFilterPresent).toBe(true);
    expect(passOf("rec-A")).toBe(false);
    expect(passOf("rec-B")).toBe(true);
    expect(passOf("rec-C")).toBe(false);

    // showChangesOnly ON + bulk = "close-q1": intersection — rowA is
    // dirty but doesn't carry the bulk id, so it fails the bulk side.
    act(() => {
      captured!.controller.setShowChangesOnly(true);
    });
    expect(passOf("rec-A")).toBe(false);
    expect(passOf("rec-B")).toBe(true);
    expect(passOf("rec-C")).toBe(false);

    // Clear bulk → only changes-only filter remains.
    act(() => {
      captured!.controller.setBulkFilter(null);
    });
    expect(passOf("rec-A")).toBe(true);
    expect(passOf("rec-B")).toBe(true);
    expect(passOf("rec-C")).toBe(false);

    // revertBulkGroup drops rowB's bulk edit → rowB no longer dirty.
    act(() => {
      captured!.controller.revertBulkGroup("close-q1");
    });
    expect(captured!.controller.dirtyCount).toBe(1); // rowA still dirty
    expect(passOf("rec-A")).toBe(true);
    expect(passOf("rec-B")).toBe(false); // no longer dirty + showChangesOnly still on
    expect(passOf("rec-C")).toBe(false);
  });

  it("setRowEffectiveDate: updates meta on every buffer entry for the row, preserves value/source", async () => {
    // Multi-field row exercises the load-bearing assertion: ALL of the
    // row's buffer entries (every dirty cell) get re-anchored to the new
    // effective_start, not just one. Other rows' entries stay untouched.
    // Value + source on each updated entry are preserved verbatim — only
    // meta.effectiveStart changes.

    const client = makeFakeClient();

    type Captured = {
      controller: ReturnType<typeof useEditableRowVersionGrid>["controller"];
      fieldSetter: (
        fieldId: string,
        type: "text",
      ) => (params: { data?: VisibleRecord; newValue: unknown }) => boolean;
    };
    let captured: Captured | null = null;

    const rowA: VisibleRecord = {
      record_id: "rec-A",
      effective_start: "2026-05-13",
      effective_end: null,
      custom_fields: [],
      values: {
        title: { type: "text", value: "Old A Title" },
        level: { type: "text", value: "Old A Level" },
      },
    };
    const rowB: VisibleRecord = {
      record_id: "rec-B",
      effective_start: "2026-05-13",
      effective_end: null,
      custom_fields: [],
      values: { title: { type: "text", value: "Old B Title" } },
    };

    function Harness() {
      const ctxRef = useRef<{ fieldSetter: Captured["fieldSetter"] } | null>(null);
      const { controller, surfaceProps } = useEditableRowVersionGrid({
        modelId: "position",
        asOf: "2026-05-13",
        scope: { appId: "hc", customerId: "demo" },
        rows: [rowA, rowB],
        client,
        // Save-time guardrail (fix #3): supply a resolution path.
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

    // Stage three edits: two on rowA, one on rowB.
    const titleSetter = captured!.fieldSetter("title", "text");
    const levelSetter = captured!.fieldSetter("level", "text");
    act(() => {
      titleSetter({ data: rowA, newValue: "New A Title" });
      levelSetter({ data: rowA, newValue: "New A Level" });
      titleSetter({ data: rowB, newValue: "New B Title" });
    });
    expect(captured!.controller.dirtyCount).toBe(3);

    // All three entries' meta.effectiveStart should currently be the
    // controller's asOf (2026-05-13).
    const summaryAInitial = captured!.controller.pendingChangesByRow.get("rec-A");
    expect(summaryAInitial?.effectiveDate).toBe("2026-05-13");
    const summaryBInitial = captured!.controller.pendingChangesByRow.get("rec-B");
    expect(summaryBInitial?.effectiveDate).toBe("2026-05-13");

    // Re-anchor rowA only.
    act(() => {
      captured!.controller.setRowEffectiveDate("rec-A", "2026-09-01");
    });

    // rowA's digest now reports the new effective date; rowB stays at
    // the original asOf.
    const summaryA = captured!.controller.pendingChangesByRow.get("rec-A");
    expect(summaryA?.effectiveDate).toBe("2026-09-01");
    const summaryB = captured!.controller.pendingChangesByRow.get("rec-B");
    expect(summaryB?.effectiveDate).toBe("2026-05-13");

    // Wire payload anchors at the new date for BOTH rowA fields, in ONE
    // write (they group by (rowKey, effectiveStart)). rowB stays at the
    // original asOf in a separate write.
    await act(async () => {
      await captured!.controller.save();
    });
    expect(client.postJson).toHaveBeenCalledTimes(1);
    const payload = (client.postJson as ReturnType<typeof vi.fn>).mock
      .calls[0]![1] as ApplyChangeSet;
    const aWrite = payload.writes.find((w) => w.record_key?.value === "rec-A");
    const bWrite = payload.writes.find((w) => w.record_key?.value === "rec-B");
    expect(aWrite).toBeDefined();
    expect(bWrite).toBeDefined();
    expect(aWrite!.effective_start).toBe("2026-09-01");
    expect(bWrite!.effective_start).toBe("2026-05-13");
    // Value preservation: rowA's title + level made it into the payload
    // intact, with the user's edited values (not the priors).
    expect(aWrite!.values).toEqual({
      title: { type: "text", value: "New A Title" },
      level: { type: "text", value: "New A Level" },
    });
    expect(bWrite!.values).toEqual({
      title: { type: "text", value: "New B Title" },
    });
  });

  it("setRowChangeType: updates meta.changeTypeId on every buffer entry for the row, drives the digest", async () => {
    // Mirror of `setRowEffectiveDate` but for change_type. Stamping an
    // explicit changeTypeId via the per-row picker MUST override the
    // hook's `inferChangeType` heuristic on the digest — that's the
    // load-bearing user intent ("I edited title alone but I want the
    // audit log to narrate it as 'Reorganization', not 'Title change'").

    const client = makeFakeClient();

    type Captured = {
      controller: ReturnType<typeof useEditableRowVersionGrid>["controller"];
      fieldSetter: (
        fieldId: string,
        type: "text",
      ) => (params: { data?: VisibleRecord; newValue: unknown }) => boolean;
    };
    let captured: Captured | null = null;

    // Inference: any touch of `title` → `title_change`. Useful for the
    // contrast: after `setRowChangeType` overrides, the digest should
    // narrate the explicit verb regardless of the inference's answer.
    const inferChangeType = (touched: string[]) =>
      touched.includes("title") ? "title_change" : "position_update";

    const rowA: VisibleRecord = {
      record_id: "rec-A",
      effective_start: "2026-05-13",
      effective_end: null,
      custom_fields: [],
      values: {
        title: { type: "text", value: "Old Title" },
        level: { type: "text", value: "Old Level" },
      },
    };

    function Harness() {
      const ctxRef = useRef<{ fieldSetter: Captured["fieldSetter"] } | null>(null);
      const { controller, surfaceProps } = useEditableRowVersionGrid({
        modelId: "position",
        asOf: "2026-05-13",
        scope: { appId: "hc", customerId: "demo" },
        rows: [rowA],
        client,
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

    // Stage two edits on rowA so multiple buffer entries exist on the
    // same row. Both must end up with meta.changeTypeId === override.
    const titleSetter = captured!.fieldSetter("title", "text");
    const levelSetter = captured!.fieldSetter("level", "text");
    act(() => {
      titleSetter({ data: rowA, newValue: "New Title" });
      levelSetter({ data: rowA, newValue: "New Level" });
    });
    expect(captured!.controller.dirtyCount).toBe(2);

    // Pre-override: digest's changeType comes from inference ("title_change").
    expect(captured!.controller.pendingChangesByRow.get("rec-A")?.changeType).toBe("title_change");

    // Override via the row picker.
    act(() => {
      captured!.controller.setRowChangeType("rec-A", "reorganization");
    });

    // Digest now reports the override.
    expect(captured!.controller.pendingChangesByRow.get("rec-A")?.changeType).toBe(
      "reorganization",
    );

    // No-op for rows with no buffer entries.
    act(() => {
      captured!.controller.setRowChangeType("rec-not-present", "title_change");
    });
    expect(captured!.controller.pendingChangesByRow.size).toBe(1);

    // Value preservation: edits still in the buffer with the new values
    // and the original source.
    expect(captured!.controller.pendingChangesByRow.get("rec-A")?.fieldChanges).toHaveLength(2);
  });

  it("modelId change wipes the buffer (no cross-model write contamination)", async () => {
    // Repro of the Devin-flagged contract gap: meta.modelId is snapshotted
    // at edit time. If a consumer swaps the `modelId` prop mid-mount,
    // entries from the prior model would otherwise persist in the buffer
    // and ride out on the next Save with the OLD model_id — a silent
    // wrong-target write that the kernel would happily apply against the
    // wrong typed table.
    //
    // The fix: a useEffect keyed on modelId clears the buffer (and the
    // invalid-cells map) so a model swap behaves like a fresh mount.
    //
    // Failure mode if regressed: dirtyCount stays at 1 after the model
    // change instead of dropping to 0.

    const client = makeFakeClient();

    type Controller = ReturnType<typeof useEditableRowVersionGrid>["controller"];
    type CapturedSetter = (
      fieldId: string,
      type: "text",
    ) => (params: { data?: VisibleRecord; newValue: unknown }) => boolean;
    type Captured = {
      controller: Controller;
      fieldSetter: CapturedSetter;
    };
    let captured: Captured | null = null;

    const row: VisibleRecord = {
      record_id: "rec-1",
      effective_start: "2026-05-13",
      effective_end: null,
      custom_fields: [],
      values: { title: { type: "text", value: "Original" } },
    };

    function Harness({ modelId }: { modelId: string }) {
      const ctxRef = useRef<{ fieldSetter: CapturedSetter } | null>(null);
      const { controller, surfaceProps } = useEditableRowVersionGrid({
        modelId,
        asOf: "2026-05-13",
        scope: { appId: "hc", customerId: "demo" },
        rows: [row],
        client,
        // Save-time guardrail (fix #3): supply a resolution path.
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

    const { rerender } = render(<Harness modelId="model-a" />);
    expect(captured).not.toBeNull();

    // Edit a cell on model-a.
    const setter = captured!.fieldSetter("title", "text");
    act(() => {
      setter({ data: row, newValue: "Edited under model-a" });
    });
    expect(captured!.controller.dirtyCount).toBe(1);

    // Stamp the OTHER stateful slots that the P11 B3 fix also clears
    // on a modelId swap: a save outcome banner (lastSaveOutcome) and
    // a bulk filter pin (activeBulkFilter / showChangesOnly). Without
    // the fix, these would bleed model-a state into a freshly-mounted
    // model-b controller. We can't directly stamp `lastSaveOutcome`
    // from a test (no public setter) — assert post-rerender it equals
    // the empty outcome value (the fix sets EMPTY_SAVE_OUTCOME).
    // `activeBulkFilter` / `showChangesOnly` are stamped via the
    // controller's setters, which ARE public.
    act(() => {
      captured!.controller.setBulkFilter("bulk-aaa");
      captured!.controller.setShowChangesOnly(true);
    });
    expect(captured!.controller.activeBulkFilter).toBe("bulk-aaa");
    expect(captured!.controller.showChangesOnly).toBe(true);

    // Swap modelId. The effect MUST clear the buffer AND the three
    // additional stateful slots per P11 B3.
    rerender(<Harness modelId="model-b" />);

    // Legacy assertion (modelId-change clears buffer).
    expect(captured!.controller.dirtyCount).toBe(0);

    // P11 B3: three additional slots reset.
    expect(captured!.controller.activeBulkFilter).toBe(null);
    expect(captured!.controller.showChangesOnly).toBe(false);
    // `lastSaveOutcome` resets to EMPTY_SAVE_OUTCOME. The empty
    // outcome carries zero counts + empty partition list — what the
    // page-side toast effect ignores via its
    // `if (outcome.perChangeSet.length === 0) return;` guard.
    expect(captured!.controller.lastSaveOutcome?.savedStageCount).toBe(0);
    expect(captured!.controller.lastSaveOutcome?.perChangeSet.length).toBe(0);
  });

  it("save (single change_type): legacy single ApplyChangeSet path preserved", async () => {
    // Sanity-anchor for the save-time-split rewrite: when every dirty cell
    // resolves to ONE effective change_type (no inferChangeType, all
    // entries fall back to the page-level `changeTypeId`), save() must
    // still emit ONE ApplyChangeSet — same wire shape as the pre-split
    // implementation. Backstop against an over-eager partition that
    // emits N empty change_sets when the answer is "one."
    const client = makeFakeClient();

    type Captured = {
      controller: ReturnType<typeof useEditableRowVersionGrid>["controller"];
      fieldSetter: (
        fieldId: string,
        type: "text",
      ) => (params: { data?: VisibleRecord; newValue: unknown }) => boolean;
    };
    let captured: Captured | null = null;

    const rowA: VisibleRecord = {
      record_id: "rec-A",
      effective_start: "2026-05-13",
      effective_end: null,
      custom_fields: [],
      values: {
        title: { type: "text", value: "Old A Title" },
        level: { type: "text", value: "Old A Level" },
      },
    };

    function Harness() {
      const ctxRef = useRef<{ fieldSetter: Captured["fieldSetter"] } | null>(null);
      const { controller, surfaceProps } = useEditableRowVersionGrid({
        modelId: "position",
        asOf: "2026-05-13",
        scope: { appId: "hc", customerId: "demo" },
        rows: [rowA],
        client,
        // No inferChangeType. Page-level default is the single source.
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

    // Stage two cells on rowA — both go to the same change_set.
    const titleSetter = captured!.fieldSetter("title", "text");
    const levelSetter = captured!.fieldSetter("level", "text");
    act(() => {
      titleSetter({ data: rowA, newValue: "New A Title" });
      levelSetter({ data: rowA, newValue: "New A Level" });
    });
    expect(captured!.controller.dirtyCount).toBe(2);

    let outcome!: SaveOutcome;
    await act(async () => {
      outcome = await captured!.controller.save();
    });

    // Wire shape: ONE postJson call carrying ONE write (rowA collapses
    // to a single RowVersionWrite with both fields in `values`).
    expect(client.postJson).toHaveBeenCalledTimes(1);
    const payload = client.postJson.mock.calls[0]![1] as ApplyChangeSet;
    expect(payload.change_type_id).toBe("position_update");
    // Default save-mode is "mainline" for direct-write app surfaces.
    expect(payload.mode).toBe("mainline");
    expect(payload.writes).toHaveLength(1);
    expect(payload.writes[0]!.values).toEqual({
      title: { type: "text", value: "New A Title" },
      level: { type: "text", value: "New A Level" },
    });

    // Outcome shape: one perChangeSet entry, all stages saved.
    expect(outcome.savedStageCount).toBe(2);
    expect(outcome.remainingStageCount).toBe(0);
    expect(outcome.perChangeSet).toHaveLength(1);
    expect(outcome.perChangeSet[0]!.changeTypeId).toBe("position_update");
    expect(outcome.perChangeSet[0]!.status).toBe("saved");
    expect(outcome.perChangeSet[0]!.stageCount).toBe(2);
    expect(captured!.controller.dirtyCount).toBe(0);
    expect(captured!.controller.lastSaveOutcome).toEqual(outcome);
  });

  it("save (saveMode draft): config.saveMode threads to ApplyChangeSet.mode", async () => {
    // App-level save-mode wiring. HC opts every save into the Drafts
    // pipeline by passing `saveMode: "draft"` through the hook config;
    // the hook MUST honor that on every partition's ApplyChangeSet
    // (not just the first one). Library default stays "mainline" so
    // apps that haven't opted in keep their pre-config behavior — the
    // companion assertion in the "single change_type" test above
    // pins that default.
    const client = makeFakeClient();

    type Captured = {
      controller: ReturnType<typeof useEditableRowVersionGrid>["controller"];
      fieldSetter: (
        fieldId: string,
        type: "text",
      ) => (params: { data?: VisibleRecord; newValue: unknown }) => boolean;
    };
    let captured: Captured | null = null;

    const rowA: VisibleRecord = {
      record_id: "rec-A",
      effective_start: "2026-05-13",
      effective_end: null,
      custom_fields: [],
      values: { title: { type: "text", value: "Old A Title" } },
    };

    function Harness() {
      const ctxRef = useRef<{ fieldSetter: Captured["fieldSetter"] } | null>(null);
      const { controller, surfaceProps } = useEditableRowVersionGrid({
        modelId: "position",
        asOf: "2026-05-13",
        scope: { appId: "hc", customerId: "demo" },
        rows: [rowA],
        client,
        changeTypeId: "position_update",
        saveMode: "draft",
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
      titleSetter({ data: rowA, newValue: "Draft A Title" });
    });
    expect(captured!.controller.dirtyCount).toBe(1);

    await act(async () => {
      await captured!.controller.save();
    });

    expect(client.postJson).toHaveBeenCalledTimes(1);
    const payload = client.postJson.mock.calls[0]![1] as ApplyChangeSet;
    expect(payload.mode).toBe("draft");
    // Sanity: every other field on the payload still serializes — the
    // saveMode hook-up touches only `mode` and shouldn't disturb the
    // other ApplyChangeSet fields.
    expect(payload.change_type_id).toBe("position_update");
    expect(payload.writes).toHaveLength(1);
    expect(payload.writes[0]!.values).toEqual({
      title: { type: "text", value: "Draft A Title" },
    });
  });

  it("save (named bulk): config.bulkGroupNotes threads to ApplyChangeSet.notes when every partition entry shares one bulk group", async () => {
    // The named-bulk wire-up. A bulk-driven save stamps every staged
    // entry with `meta.bulkGroupId`; the hook's partition-by-change_type
    // pass detects that the partition's entries all share ONE id and
    // calls `bulkGroupNotes(id)` to resolve the human label. The
    // resulting ApplyChangeSet carries `notes` so the kernel records
    // it on the change_set — Approvals page reads that as the named-
    // bulk card title.
    //
    // Companion: a hand edit (no bulkGroupId on its meta) emits a
    // SECOND partition whose ApplyChangeSet has no `notes` field —
    // pins the "don't leak `notes: undefined` on non-bulk saves"
    // contract so the wire shape stays clean for unnamed drafts.
    const client = makeFakeClient();

    type Captured = {
      controller: ReturnType<typeof useEditableRowVersionGrid>["controller"];
      fieldSetter: (
        fieldId: string,
        type: "text" | "bool",
      ) => (params: { data?: VisibleRecord; newValue: unknown }) => boolean;
    };
    let captured: Captured | null = null;

    const rowA: VisibleRecord = {
      record_id: "rec-A",
      effective_start: "2026-05-13",
      effective_end: null,
      custom_fields: [],
      values: {
        title: { type: "text", value: "Old A Title" },
        is_open: { type: "bool", value: true },
      },
    };
    const rowB: VisibleRecord = {
      record_id: "rec-B",
      effective_start: "2026-05-13",
      effective_end: null,
      custom_fields: [],
      values: {
        title: { type: "text", value: "Old B Title" },
        is_open: { type: "bool", value: true },
      },
    };

    // Inference: `title` → "title_change"; `is_open` → "close_positions".
    // We stage one hand title edit on rowA (no bulk id) AND one bulk
    // close on rowB (with bulk id "bulk-q1"). Two partitions: the bulk
    // partition gets `notes`, the hand-edit one stays note-less.
    const inferChangeType = (touched: string[]) => {
      const set = new Set(touched);
      if (set.has("is_open")) return "close_positions";
      if (set.has("title")) return "title_change";
      return "position_update";
    };

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
        // The hook calls this with each partition's resolved bulkGroupId
        // (when the partition's entries all share one). Returning
        // undefined for unknown ids → the wire payload omits `notes`.
        bulkGroupNotes: (id) => (id === "bulk-q1" ? "Close 5 Q1 positions" : undefined),
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

    // Hand edit on rowA (title → "title_change", no bulkGroupId).
    const titleSetter = captured!.fieldSetter("title", "text");
    act(() => {
      titleSetter({ data: rowA, newValue: "Renamed A" });
    });
    // Bulk close on rowB (is_open → "close_positions", bulkGroupId = "bulk-q1").
    act(() => {
      captured!.controller.stageBulkUpdate({
        rows: [{ rowKey: "rec-B" }],
        fieldId: "is_open",
        value: { type: "bool", value: false },
        bulkGroupId: "bulk-q1",
      });
    });
    expect(captured!.controller.dirtyCount).toBe(2);

    await act(async () => {
      await captured!.controller.save();
    });

    // TWO postJson calls (two partitions). Hand-edit (title_change) lands
    // first because rowA's entry was staged first.
    expect(client.postJson).toHaveBeenCalledTimes(2);
    const handEditPayload = client.postJson.mock.calls[0]![1] as ApplyChangeSet;
    const bulkPayload = client.postJson.mock.calls[1]![1] as ApplyChangeSet;

    // Hand-edit partition: no bulkGroupId on any entry → notes field is
    // OMITTED from the wire payload (not sent as `undefined`). This is
    // load-bearing: useApplyChangeSet stableStringifies the payload to
    // compute the idempotency fingerprint, so a phantom `notes:
    // undefined` would silently shift the fingerprint for non-bulk
    // saves.
    expect(handEditPayload.change_type_id).toBe("title_change");
    expect("notes" in handEditPayload).toBe(false);

    // Bulk partition: every entry shares "bulk-q1" → bulkGroupNotes
    // resolves to the user-typed batch name → payload.notes carries it.
    expect(bulkPayload.change_type_id).toBe("close_positions");
    expect(bulkPayload.notes).toBe("Close 5 Q1 positions");
  });

  it("save (multi change_type): partitions into N ApplyChangeSets with distinct change_type_ids + idempotency_keys", async () => {
    // The headline case for save-time splitting: TWO rows whose touched
    // fields infer to DIFFERENT change_types must serialize into TWO
    // postJson calls, each carrying:
    //   - a distinct change_type_id matching the row's resolution,
    //   - a distinct idempotency_key (fresh-key-per-success in
    //     useApplyChangeSet),
    //   - only the writes for THAT partition's rows.
    //
    // Inference: `title` → `title_change`; `is_open` → `close_positions`.
    // rowA touches title → "title_change"; rowB touches is_open →
    // "close_positions". Two partitions, two apply calls.

    const client = makeFakeClient();

    const inferChangeType = (touched: string[]) => {
      const set = new Set(touched);
      if (set.has("title")) return "title_change";
      if (set.has("is_open")) return "close_positions";
      return "position_update";
    };

    type Captured = {
      controller: ReturnType<typeof useEditableRowVersionGrid>["controller"];
      fieldSetter: (
        fieldId: string,
        type: "text" | "bool",
      ) => (params: { data?: VisibleRecord; newValue: unknown }) => boolean;
    };
    let captured: Captured | null = null;

    const rowA: VisibleRecord = {
      record_id: "rec-A",
      effective_start: "2026-05-13",
      effective_end: null,
      custom_fields: [],
      values: {
        title: { type: "text", value: "Old A Title" },
        is_open: { type: "bool", value: true },
      },
    };
    const rowB: VisibleRecord = {
      record_id: "rec-B",
      effective_start: "2026-05-13",
      effective_end: null,
      custom_fields: [],
      values: {
        title: { type: "text", value: "Old B Title" },
        is_open: { type: "bool", value: true },
      },
    };
    const rowC: VisibleRecord = {
      record_id: "rec-C",
      effective_start: "2026-05-13",
      effective_end: null,
      custom_fields: [],
      values: {
        title: { type: "text", value: "Old C Title" },
        is_open: { type: "bool", value: true },
      },
    };

    function Harness() {
      const ctxRef = useRef<{ fieldSetter: Captured["fieldSetter"] } | null>(null);
      const { controller, surfaceProps } = useEditableRowVersionGrid({
        modelId: "position",
        asOf: "2026-05-13",
        scope: { appId: "hc", customerId: "demo" },
        rows: [rowA, rowB, rowC],
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

    // Stage: two title edits (rowA title, rowC title) → "title_change",
    // and one is_open edit on rowB → "close_positions".
    const titleSetter = captured!.fieldSetter("title", "text");
    act(() => {
      titleSetter({ data: rowA, newValue: "New A Title" });
      titleSetter({ data: rowC, newValue: "New C Title" });
    });
    act(() => {
      captured!.controller.stageBulkUpdate({
        rows: [{ rowKey: "rec-B" }],
        fieldId: "is_open",
        value: { type: "bool", value: false },
        bulkGroupId: "close-q1",
      });
    });
    expect(captured!.controller.dirtyCount).toBe(3);

    let outcome!: SaveOutcome;
    await act(async () => {
      outcome = await captured!.controller.save();
    });

    // TWO postJson calls. Buffer-insertion order means title_change
    // (rowA touched first) lands first; close_positions (rowB) second.
    expect(client.postJson).toHaveBeenCalledTimes(2);
    const first = client.postJson.mock.calls[0]![1] as ApplyChangeSet;
    const second = client.postJson.mock.calls[1]![1] as ApplyChangeSet;

    expect(first.change_type_id).toBe("title_change");
    expect(first.writes).toHaveLength(2);
    const firstRecordIds = first.writes.map((w) => w.record_key?.value).sort();
    expect(firstRecordIds).toEqual(["rec-A", "rec-C"]);

    expect(second.change_type_id).toBe("close_positions");
    expect(second.writes).toHaveLength(1);
    expect(second.writes[0]!.record_key?.value).toBe("rec-B");

    // Distinct idempotency_keys: useApplyChangeSet mints fresh on success.
    expect(first.idempotency_key).toBeTruthy();
    expect(second.idempotency_key).toBeTruthy();
    expect(first.idempotency_key).not.toBe(second.idempotency_key);

    // Outcome breakdown: two perChangeSet entries, both saved, sums match.
    expect(outcome.savedStageCount).toBe(3);
    expect(outcome.remainingStageCount).toBe(0);
    expect(outcome.perChangeSet).toHaveLength(2);
    expect(outcome.perChangeSet[0]!.changeTypeId).toBe("title_change");
    expect(outcome.perChangeSet[0]!.status).toBe("saved");
    expect(outcome.perChangeSet[0]!.stageCount).toBe(2);
    expect(outcome.perChangeSet[1]!.changeTypeId).toBe("close_positions");
    expect(outcome.perChangeSet[1]!.status).toBe("saved");
    expect(outcome.perChangeSet[1]!.stageCount).toBe(1);
    expect(captured!.controller.dirtyCount).toBe(0);
    expect(captured!.controller.lastSaveOutcome).toEqual(outcome);
  });

  it("save (partial failure): first group clears, second group stays dirty + lastSaveOutcome surfaces both", async () => {
    // Multi-type save where the FIRST partition succeeds and the SECOND
    // fails. The succeeded partition's entries clear from the buffer
    // (revertMatching against the snapshot); the failed partition's
    // entries stay dirty for retry. The loop bails on the first failure
    // (we don't want N independent failures surprising the user). The
    // `lastSaveOutcome` carries both results so the page can render the
    // mixed-state banner.

    let attempt = 0;
    const client = makeFakeClient(async () => {
      attempt += 1;
      // First call (partition 1: title_change) succeeds.
      // Second call (partition 2: close_positions) fails.
      if (attempt === 1) return { id: 1, schema_revision_id: "1" };
      throw {
        code: "kernel_failure",
        message: "Cannot close: validation rule violated",
        details: [],
      };
    });

    const inferChangeType = (touched: string[]) => {
      const set = new Set(touched);
      if (set.has("title")) return "title_change";
      if (set.has("is_open")) return "close_positions";
      return "position_update";
    };

    type Captured = {
      controller: ReturnType<typeof useEditableRowVersionGrid>["controller"];
      fieldSetter: (
        fieldId: string,
        type: "text",
      ) => (params: { data?: VisibleRecord; newValue: unknown }) => boolean;
    };
    let captured: Captured | null = null;

    const rowA: VisibleRecord = {
      record_id: "rec-A",
      effective_start: "2026-05-13",
      effective_end: null,
      custom_fields: [],
      values: {
        title: { type: "text", value: "Old A Title" },
        is_open: { type: "bool", value: true },
      },
    };
    const rowB: VisibleRecord = {
      record_id: "rec-B",
      effective_start: "2026-05-13",
      effective_end: null,
      custom_fields: [],
      values: { is_open: { type: "bool", value: true } },
    };

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

    // Stage: rowA title → title_change; rowB is_open → close_positions.
    const titleSetter = captured!.fieldSetter("title", "text");
    act(() => {
      titleSetter({ data: rowA, newValue: "New A Title" });
    });
    act(() => {
      captured!.controller.stageBulkUpdate({
        rows: [{ rowKey: "rec-B" }],
        fieldId: "is_open",
        value: { type: "bool", value: false },
        bulkGroupId: "close-q1",
      });
    });
    expect(captured!.controller.dirtyCount).toBe(2);

    let outcome!: SaveOutcome;
    await act(async () => {
      outcome = await captured!.controller.save();
    });

    // Two postJson calls (the loop attempted both groups; the second
    // threw but the call happened).
    expect(client.postJson).toHaveBeenCalledTimes(2);

    // Buffer state: title_change cleared (rowA's title gone); close_positions
    // partition stayed (rowB's is_open still dirty).
    expect(captured!.controller.dirtyCount).toBe(1);
    expect(captured!.controller.pendingChangesByRow.has("rec-A")).toBe(false);
    expect(captured!.controller.pendingChangesByRow.has("rec-B")).toBe(true);

    // Outcome: 1 saved, 1 remaining; perChangeSet has both results in apply order.
    expect(outcome.savedStageCount).toBe(1);
    expect(outcome.remainingStageCount).toBe(1);
    expect(outcome.perChangeSet).toHaveLength(2);
    expect(outcome.perChangeSet[0]!.changeTypeId).toBe("title_change");
    expect(outcome.perChangeSet[0]!.status).toBe("saved");
    expect(outcome.perChangeSet[0]!.stageCount).toBe(1);
    expect(outcome.perChangeSet[1]!.changeTypeId).toBe("close_positions");
    expect(outcome.perChangeSet[1]!.status).toBe("failed");
    expect(outcome.perChangeSet[1]!.stageCount).toBe(1);
    expect(outcome.perChangeSet[1]!.error).toBeDefined();
    expect(outcome.perChangeSet[1]!.error!.code).toBe("kernel_failure");
    expect(outcome.perChangeSet[1]!.error!.message).toMatch(/validation rule violated/);

    // lastSaveOutcome mirrors the returned outcome for the banner.
    expect(captured!.controller.lastSaveOutcome).toEqual(outcome);
    // submitError surfaces the trailing failure (the most-recent-error
    // channel useApplyChangeSet maintains).
    expect(captured!.controller.submitError?.code).toBe("kernel_failure");
  });

  it("save treats apply responses without change-set ids as failed and keeps entries dirty", async () => {
    const client = makeFakeClient(async () => ({ schema_revision_id: "1" }) as AppliedChangeSet);

    type Captured = {
      controller: ReturnType<typeof useEditableRowVersionGrid>["controller"];
      fieldSetter: (
        fieldId: string,
        type: "text",
      ) => (params: { data?: VisibleRecord; newValue: unknown }) => boolean;
    };
    let captured: Captured | null = null;

    const row: VisibleRecord = {
      record_id: "rec-A",
      effective_start: "2026-05-13",
      effective_end: null,
      custom_fields: [],
      values: {
        title: { type: "text", value: "Old Title" },
      },
    };

    function Harness() {
      const { controller, surfaceProps } = useEditableRowVersionGrid({
        modelId: "position",
        asOf: "2026-05-13",
        scope: { appId: "hc", customerId: "demo" },
        rows: [row],
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

    act(() => {
      captured!.fieldSetter("title", "text")({ data: row, newValue: "New Title" });
    });

    let outcome!: SaveOutcome;
    await act(async () => {
      outcome = await captured!.controller.save();
    });

    expect(client.postJson).toHaveBeenCalledTimes(1);
    expect(captured!.controller.dirtyCount).toBe(1);
    expect(outcome.savedStageCount).toBe(0);
    expect(outcome.remainingStageCount).toBe(1);
    expect(outcome.perChangeSet).toEqual([
      expect.objectContaining({
        changeTypeId: "position_update",
        status: "failed",
        error: expect.objectContaining({
          code: "invalid_apply_response",
          message: "Server response did not include a change_set id.",
        }),
      }),
    ]);
  });

  it("save (retry after partial failure): only the failed group is sent + idempotency_key reused", async () => {
    // Continuation of the partial-failure scenario: after the first save()
    // half-lands, the user clicks Save again. Only the FAILED partition
    // remains dirty, so save() rebuilds with just that partition's
    // entries. The `useApplyChangeSet` hook's catch branch did NOT clear
    // the idempotency_key on the failed partition's apply (only success
    // clears it), so the retry's idempotency_key MUST match the failed
    // call's key. The kernel uses this for partial-applied dedup.

    let attempt = 0;
    const client = makeFakeClient(async () => {
      attempt += 1;
      if (attempt === 1) return { id: 1, schema_revision_id: "1" }; // partition A
      if (attempt === 2) throw { code: "kernel_failure", message: "boom", details: [] }; // partition B (fails)
      return { id: 2, schema_revision_id: "1" }; // retry: partition B succeeds
    });

    const inferChangeType = (touched: string[]) => {
      const set = new Set(touched);
      if (set.has("title")) return "title_change";
      if (set.has("is_open")) return "close_positions";
      return "position_update";
    };

    type Captured = {
      controller: ReturnType<typeof useEditableRowVersionGrid>["controller"];
      fieldSetter: (
        fieldId: string,
        type: "text",
      ) => (params: { data?: VisibleRecord; newValue: unknown }) => boolean;
    };
    let captured: Captured | null = null;

    const rowA: VisibleRecord = {
      record_id: "rec-A",
      effective_start: "2026-05-13",
      effective_end: null,
      custom_fields: [],
      values: {
        title: { type: "text", value: "Old A Title" },
        is_open: { type: "bool", value: true },
      },
    };
    const rowB: VisibleRecord = {
      record_id: "rec-B",
      effective_start: "2026-05-13",
      effective_end: null,
      custom_fields: [],
      values: { is_open: { type: "bool", value: true } },
    };

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

    const titleSetter = captured!.fieldSetter("title", "text");
    act(() => {
      titleSetter({ data: rowA, newValue: "New A Title" });
    });
    act(() => {
      captured!.controller.stageBulkUpdate({
        rows: [{ rowKey: "rec-B" }],
        fieldId: "is_open",
        value: { type: "bool", value: false },
        bulkGroupId: "close-q1",
      });
    });

    // First save: partition A succeeds, B fails. Buffer keeps B's entry.
    await act(async () => {
      await captured!.controller.save();
    });
    expect(client.postJson).toHaveBeenCalledTimes(2);
    expect(captured!.controller.dirtyCount).toBe(1);

    // Retry. Only partition B's entries remain → save() rebuilds the
    // close_positions partition only → ONE postJson call.
    await act(async () => {
      await captured!.controller.save();
    });
    expect(client.postJson).toHaveBeenCalledTimes(3);

    const partitionAKey = (client.postJson.mock.calls[0]![1] as ApplyChangeSet).idempotency_key;
    const partitionBFailedKey = (client.postJson.mock.calls[1]![1] as ApplyChangeSet)
      .idempotency_key;
    const partitionBRetryKey = (client.postJson.mock.calls[2]![1] as ApplyChangeSet)
      .idempotency_key;

    // The partition-B retry MUST reuse the failed call's key — kernel
    // dedups partial-applied writes on this. The succeeded partition's
    // key is distinct.
    expect(partitionBRetryKey).toBe(partitionBFailedKey);
    expect(partitionBRetryKey).not.toBe(partitionAKey);

    // The retry's payload is the close_positions group only; check
    // change_type_id matches the failed call's change_type_id.
    const retryPayload = client.postJson.mock.calls[2]![1] as ApplyChangeSet;
    expect(retryPayload.change_type_id).toBe("close_positions");
    expect(retryPayload.writes).toHaveLength(1);
    expect(retryPayload.writes[0]!.record_key?.value).toBe("rec-B");

    // Buffer drains; lastSaveOutcome reflects the retry's success.
    expect(captured!.controller.dirtyCount).toBe(0);
    const finalOutcome = captured!.controller.lastSaveOutcome!;
    expect(finalOutcome.savedStageCount).toBe(1);
    expect(finalOutcome.remainingStageCount).toBe(0);
    expect(finalOutcome.perChangeSet).toHaveLength(1);
    expect(finalOutcome.perChangeSet[0]!.changeTypeId).toBe("close_positions");
    expect(finalOutcome.perChangeSet[0]!.status).toBe("saved");
  });

  it("save (retry after partial failure + re-edit in failed partition): retry mints a FRESH idempotency_key", async () => {
    // Same setup as the retry-after-partial-failure test, except the user
    // re-edits the failed partition's row BETWEEN the two save() calls.
    // The payload fingerprint changes (different field value on the wire),
    // so `useApplyChangeSet` MUST mint a NEW idempotency_key for the
    // retry — reusing the prior key would let the kernel dedupe against
    // the earlier failed attempt and silently lose the new edit.
    //
    // Pair with the prior test ("idempotency_key reused"): together they
    // pin the hook's two-axis contract — same payload → same key; changed
    // payload → fresh key, even when the call is logically a retry.

    let attempt = 0;
    const client = makeFakeClient(async () => {
      attempt += 1;
      if (attempt === 1) return { id: 1, schema_revision_id: "1" }; // partition A
      if (attempt === 2) throw { code: "kernel_failure", message: "boom", details: [] }; // partition B (fails)
      return { id: 2, schema_revision_id: "1" }; // retry: partition B succeeds (with new value)
    });

    const inferChangeType = (touched: string[]) => {
      const set = new Set(touched);
      if (set.has("title")) return "title_change";
      if (set.has("is_open")) return "close_positions";
      return "position_update";
    };

    type Captured = {
      controller: ReturnType<typeof useEditableRowVersionGrid>["controller"];
      fieldSetter: (
        fieldId: string,
        type: "text",
      ) => (params: { data?: VisibleRecord; newValue: unknown }) => boolean;
    };
    let captured: Captured | null = null;

    const rowA: VisibleRecord = {
      record_id: "rec-A",
      effective_start: "2026-05-13",
      effective_end: null,
      custom_fields: [],
      values: {
        title: { type: "text", value: "Old A Title" },
        is_open: { type: "bool", value: true },
      },
    };
    const rowB: VisibleRecord = {
      record_id: "rec-B",
      effective_start: "2026-05-13",
      effective_end: null,
      custom_fields: [],
      values: { is_open: { type: "bool", value: true } },
    };

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

    // Stage initial edits: rowA title (will succeed) + rowB is_open=false
    // via bulk update (will fail on the first save).
    const titleSetter = captured!.fieldSetter("title", "text");
    act(() => {
      titleSetter({ data: rowA, newValue: "New A Title" });
    });
    act(() => {
      captured!.controller.stageBulkUpdate({
        rows: [{ rowKey: "rec-B" }],
        fieldId: "is_open",
        value: { type: "bool", value: false },
        bulkGroupId: "close-q1",
      });
    });

    // First save: A succeeds, B fails. Buffer keeps B's entry.
    await act(async () => {
      await captured!.controller.save();
    });
    expect(client.postJson).toHaveBeenCalledTimes(2);
    expect(captured!.controller.dirtyCount).toBe(1);

    // The user adds a second edit to the failed partition between saves
    // by widening the bulk close to also include rec-A's is_open (which
    // was previously open=true). The retry's close_positions
    // ApplyChangeSet now wraps TWO writes (rec-A + rec-B) instead of the
    // failed call's ONE — different fingerprint → fresh idempotency_key.
    //
    // The matching "no re-edit → key reused" path is covered by the
    // prior test in this block; this test pins the inverse so a future
    // refactor can't silently drop the fingerprint check and start
    // reusing keys across payload-distinct retries (kernel would then
    // dedupe and the second edit would be lost).
    act(() => {
      captured!.controller.stageBulkUpdate({
        rows: [{ rowKey: "rec-A" }],
        fieldId: "is_open",
        value: { type: "bool", value: false },
        bulkGroupId: "close-q1-v2",
      });
    });
    expect(captured!.controller.dirtyCount).toBe(2);

    // Retry. The close_positions partition now has 2 writes (rec-A + rec-B)
    // instead of the failed call's 1 (rec-B only). Different payload →
    // useApplyChangeSet recognizes the fingerprint shift → fresh
    // idempotency_key.
    await act(async () => {
      await captured!.controller.save();
    });
    expect(client.postJson).toHaveBeenCalledTimes(3);

    const partitionBFailedKey = (client.postJson.mock.calls[1]![1] as ApplyChangeSet)
      .idempotency_key;
    const partitionBRetryKey = (client.postJson.mock.calls[2]![1] as ApplyChangeSet)
      .idempotency_key;
    const retryPayload = client.postJson.mock.calls[2]![1] as ApplyChangeSet;

    // Both keys truthy (sanity guard).
    expect(partitionBFailedKey).toBeTruthy();
    expect(partitionBRetryKey).toBeTruthy();

    // Load-bearing assertion: changed payload → DIFFERENT idempotency_key.
    // The reuse case (no re-edit) is covered by the prior test in this
    // block; this test pins the inverse — kernel-side dedupe is NOT a
    // silent-drop trap when the user edited between attempts.
    expect(partitionBRetryKey).not.toBe(partitionBFailedKey);

    // The retry partition wraps both restaged cells (rec-A + rec-B) and
    // targets the close_positions change_type.
    expect(retryPayload.change_type_id).toBe("close_positions");
    expect(retryPayload.writes).toHaveLength(2);
  });
});
