import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import type { Schema, FieldValue, ModelId } from "@contracts";
import type { EditableGridPreviewController } from "@modules/editable-grid";
import { PreviewSavePanel } from "../components/PreviewSavePanel";
import type { WriteBoundImportPreview } from "../types";

// Keep the actual preview hook and staging/validation buffer; omit only AG Grid painting.
vi.mock("@modules/editable-grid", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@modules/editable-grid")>();
  return { ...actual, EditableRowVersionGrid: () => <div aria-label="Editable preview" /> };
});
const text = (value: string): FieldValue => ({ type: "text", value });
const schema = {
  app_id: "test",
  customer_id: "customer",
  version: "1",
  change_types: [],
  models: ["people", "departments"].map((id) => ({
    id,
    label: id,
    kind: "entity",
    fields: [{ id: "name", label: "Name", type: "text" }],
  })),
} as unknown as Schema;
function preview(issue = false): WriteBoundImportPreview {
  return {
    changeCount: 2,
    saveBlockingReason: issue ? "needs_review_rows" : null,
    modelTabs: ["people", "departments"].map((modelId) => ({
      modelId,
      label: modelId,
      rowCount: 1,
      readyRowCount: 1,
      needsReviewRowCount: 0,
      parseErrorRowCount: 0,
    })),
    rowsByModel: {
      people: {
        existing: [
          {
            recordId: "person-1",
            effectiveStart: "2026-09-01",
            priorValues: { name: text("Prior") },
            values: { name: text("Proposed") },
            ...(issue
              ? {
                  issues: [
                    { code: "review", path: "name", fieldId: "name", message: "Confirm name" },
                  ],
                }
              : {}),
          },
        ],
      },
      departments: {
        creates: [
          {
            tempRowId: "dept-temp",
            newRecordId: "dept-1",
            effectiveStart: "2026-09-01",
            values: { name: text("Operations") },
          },
        ],
      },
    },
  };
}
function mount(value = preview()) {
  let controllers: ReadonlyMap<ModelId, EditableGridPreviewController> = new Map();
  const onSave = vi.fn();
  const onControllersChange = (next: ReadonlyMap<ModelId, EditableGridPreviewController>) => {
    controllers = next;
  };
  render(
    <PreviewSavePanel
      preview={value}
      schema={schema}
      scope={{ appId: "test", customerId: "customer" }}
      asOf="2026-09-01"
      fieldOverridesByModel={{}}
      saving={false}
      onSave={onSave}
      onControllersChange={onControllersChange}
    />,
  );
  return { onSave, controllers: () => controllers };
}

describe("PreviewSavePanel preview-only controller boundary", () => {
  it("stages multiple models without publishing and delegates one Save to the host", async () => {
    const host = mount();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save 2 changes" })).toBeEnabled(),
    );
    expect(host.controllers().get("people")?.pendingChangesByRow.has("person-1")).toBe(true);
    expect(host.controllers().get("departments")?.pendingChangesByRow.size).toBe(1);
    for (const controller of host.controllers().values()) {
      expect(controller).not.toHaveProperty("save");
      expect(controller).not.toHaveProperty("prepareAtomicSave");
    }
    fireEvent.click(screen.getByRole("tab", { name: /departments/ }));
    expect(host.controllers().get("people")?.pendingChangesByRow.has("person-1")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Save 2 changes" }));
    expect(host.onSave).toHaveBeenCalledTimes(1);
  });
  it("keeps Save blocked until a seeded invalid cell is corrected", async () => {
    const host = mount(preview(true));
    await waitFor(() => expect(host.controllers().get("people")?.invalidCellCount).toBe(1));
    expect(screen.getByRole("button", { name: /Save/ })).toBeDisabled();
    act(() => {
      expect(
        host
          .controllers()
          .get("people")!
          .stageBulkUpdate({
            rows: [{ rowKey: "person-1" }],
            values: { name: text("Confirmed") },
            bulkGroupId: "human",
            initialInvalidCells: {},
          }),
      ).toEqual({ ok: true });
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save 2 changes" })).toBeEnabled(),
    );
  });
  it("disables Save after all staged edits are reverted", async () => {
    const value = preview();
    value.modelTabs = value.modelTabs.slice(0, 1);
    const host = mount(value);
    await waitFor(() => expect(host.controllers().get("people")?.pendingChangesByRow.size).toBe(1));
    act(() => host.controllers().get("people")!.revertRowEdits("person-1"));
    await waitFor(() => expect(host.controllers().get("people")?.pendingChangesByRow.size).toBe(0));
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(host.onSave).not.toHaveBeenCalled();
  });
  it("does not stage a clear of a cell that is already empty", async () => {
    const value = preview();
    value.modelTabs = value.modelTabs.slice(0, 1);
    value.rowsByModel = {
      people: {
        existing: [
          {
            recordId: "person-1",
            effectiveStart: "2026-09-01",
            priorValues: {},
            values: {},
            clearFields: ["name"],
          },
        ],
      },
    };
    const host = mount(value);
    await waitFor(() => expect(host.controllers().get("people")).toBeDefined());
    expect(host.controllers().get("people")?.pendingChangesByRow.size).toBe(0);
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });
});
