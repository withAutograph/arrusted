// @vitest-environment jsdom

// A link picker opened in the real grid: picking an option with the pointer
// stages it. The option list floats outside the grid's popup editor, and the
// grid must not close the editor on the option's mousedown.

import { act, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vite-plus/test";
import type { GridApi } from "ag-grid-community";

import type { KernelClient, Schema, VisibleRecord } from "@contracts";

import { bootstrapAgGrid, EditableRowVersionGrid, useEditableRowVersionGrid } from "../index";

bootstrapAgGrid({ allowMissingLicense: true });

const SCHEMA: Schema = {
  app_id: "demo",
  customer_id: "demo",
  version: "1",
  models: [
    {
      id: "widget",
      kind: "entity",
      label: "Widget",
      fields: [
        { id: "name", label: "Name", type: "text", required: true },
        { id: "owner", label: "Owner", type: "relation", required: false, target_model: "person" },
      ],
    },
    { id: "person", kind: "entity", label: "Person", fields: [] },
  ],
  change_types: [
    { id: "widget_update", label: "Update", target_model: "widget", touches: [], required: [] },
  ],
};

const ROWS: VisibleRecord[] = [
  {
    record_id: "w-1",
    effective_start: "2026-01-01",
    values: { name: { type: "text", value: "North" } },
    custom_fields: [],
  },
];

const OPTIONS = {
  person: [
    { key: { type: "record_id" as const, value: "p-1" }, label: "Alice Bluth" },
    { key: { type: "record_id" as const, value: "p-2" }, label: "Bob Loblaw" },
  ],
};

describe("link picker in the grid", () => {
  it("stages an option picked with the pointer", async () => {
    const client = { postJson: vi.fn(), getJson: vi.fn() } as unknown as KernelClient;
    let api: GridApi | null = null;
    let controller: ReturnType<typeof useEditableRowVersionGrid>["controller"] | null = null;

    function Harness() {
      const grid = useEditableRowVersionGrid({
        modelId: "widget",
        asOf: "2026-10-19",
        scope: { appId: "demo", customerId: "demo" },
        rows: ROWS,
        client,
        schema: SCHEMA,
        model: "widget",
        changeTypeId: "widget_update",
        relationOptionsByModel: OPTIONS,
      });
      controller = grid.controller;
      return (
        <div style={{ width: 1200, height: 600 }}>
          <EditableRowVersionGrid
            {...grid.surfaceProps}
            onGridReady={(event) => {
              api = event.api as unknown as GridApi;
              grid.surfaceProps.onGridReady(event);
            }}
          />
        </div>
      );
    }

    const user = userEvent.setup();
    render(<Harness />);
    await waitFor(() => expect(api).not.toBeNull());
    await waitFor(() => expect(screen.getByText("North")).toBeInTheDocument());
    act(() => {
      // jsdom cannot measure the grid's default popup parent.
      api!.setGridOption("popupParent", document.body);
      api!.startEditingCell({ rowIndex: 0, colKey: "owner" });
    });

    await user.click(await screen.findByRole("option", { name: "Bob Loblaw" }));

    await waitFor(() =>
      expect(
        controller!.pendingChangesByRow
          .get("w-1")
          ?.fieldChanges.find((change) => change.fieldId === "owner")?.next,
      ).toEqual({ type: "relation", value: { type: "record_id", value: "p-2" } }),
    );
  });
});
