// Date-and-time and list-of-text cells in the shared grid: the real editors
// stage FieldValues through the column setter, paste is parsed, empty values
// clear optional fields (declared and custom) and required ones refuse.

import { describe, expect, it, vi } from "vite-plus/test";
import type { ComponentType } from "react";
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ColDef, ValueSetterParams } from "ag-grid-community";

import type { AppliedChangeSet, KernelClient, Schema, VisibleRecord } from "@contracts";

import { useEditableRowVersionGrid } from "../index";

const SCHEMA: Schema = {
  app_id: "demo",
  customer_id: "demo",
  version: "1",
  models: [
    {
      id: "widget",
      kind: "entity",
      label: "Widget",
      extensions: { typed_custom_fields: true },
      fields: [
        { id: "name", label: "Name", type: "text", required: true },
        { id: "checked_at", label: "Checked", type: "datetime", required: true },
        { id: "labels", label: "Labels", type: "text_list", required: false },
        { id: "codes", label: "Codes", type: "text_list", required: true },
      ],
    },
  ],
  custom_fields: [
    { id: "cfd_seen", model_id: "widget", field_id: "cf_seen", label: "Seen", type: "datetime" },
    { id: "cfd_tags", model_id: "widget", field_id: "cf_tags", label: "Tags", type: "text_list" },
  ],
  change_types: [
    { id: "widget_update", label: "Update", target_model: "widget", touches: [], required: [] },
  ],
};

const ROW: VisibleRecord = {
  record_id: "w-1",
  effective_start: "2026-01-01",
  effective_end: null,
  values: {
    name: { type: "text", value: "North" },
    checked_at: { type: "datetime", value: "2026-05-01T08:00:00Z" },
    labels: { type: "text_list", value: ["a"] },
    codes: { type: "text_list", value: ["X1"] },
  },
  custom_fields: [
    { field_id: "cf_seen", type: "datetime", value: "2026-05-04T12:00:00Z" },
    { field_id: "cf_tags", type: "text_list", value: ["outdoor", "priority"] },
  ],
};

function mountGrid() {
  const postJson = vi.fn(async (_path: string, _body: unknown): Promise<AppliedChangeSet> => ({
    id: 7,
    schema_revision_id: "1",
  }));
  const kernel = { postJson, getJson: vi.fn(async () => []) } as unknown as KernelClient;
  const hook = renderHook(() =>
    useEditableRowVersionGrid({
      modelId: "widget",
      asOf: "2026-10-17",
      scope: { appId: "demo", customerId: "demo" },
      rows: [ROW],
      client: kernel,
      schema: SCHEMA,
      model: "widget",
      changeTypeId: "widget_update",
    }),
  );
  return { hook, postJson };
}

type Grid = ReturnType<typeof mountGrid>;

function column(grid: Grid, fieldId: string): ColDef<VisibleRecord> {
  return grid.hook.result.current.surfaceProps.columnDefs.find(
    (col) => col.colId === fieldId,
  ) as ColDef<VisibleRecord>;
}

function row(grid: Grid): VisibleRecord {
  return grid.hook.result.current.surfaceProps.rows[0] as VisibleRecord;
}

// A paste, fill or Delete: AG Grid calls the column's valueSetter with text or null.
function setCell(grid: Grid, fieldId: string, newValue: unknown): boolean {
  const setter = column(grid, fieldId).valueSetter as (
    params: ValueSetterParams<VisibleRecord>,
  ) => boolean;
  let accepted = false;
  act(() => {
    accepted = setter({ data: row(grid), newValue } as ValueSetterParams<VisibleRecord>);
  });
  return accepted;
}

// Mounts a column's real cell editor the way AG Grid does: `setDataValue`
// runs the column's valueSetter, which stages into the grid's buffer.
// `closeByGrid` does what AG Grid does when it closes the editor itself (Tab):
// it hands the editor's last reported value to the same valueSetter, if it
// differs from the cell's value.
function mountEditor(grid: Grid, fieldId: string) {
  const col = column(grid, fieldId);
  const data = row(grid);
  const getter = col.valueGetter as (params: { data: VisibleRecord }) => unknown;
  const setter = col.valueSetter as (params: ValueSetterParams<VisibleRecord>) => boolean;
  const Editor = col.cellEditor as ComponentType<Record<string, unknown>>;
  const stopEditing = vi.fn();
  const value = getter({ data });
  let editorValue: unknown = value;
  render(
    <Editor
      {...(col.cellEditorParams as Record<string, unknown>)}
      value={value}
      data={data}
      colDef={col}
      column={{ getColId: () => fieldId }}
      node={{
        setDataValue: (_column: unknown, newValue: unknown) =>
          act(() => {
            setter({ data, newValue } as ValueSetterParams<VisibleRecord>);
          }),
      }}
      api={{ stopEditing }}
      onValueChange={(next: unknown) => {
        editorValue = next;
      }}
    />,
  );
  const closeByGrid = () => {
    if (editorValue === value) return;
    act(() => {
      setter({ data, newValue: editorValue } as ValueSetterParams<VisibleRecord>);
    });
  };
  return { stopEditing, closeByGrid };
}

function pending(grid: Grid, fieldId: string) {
  return grid.hook.result.current.controller.pendingChangesByRow
    .get("w-1")
    ?.fieldChanges.find((change) => change.fieldId === fieldId)?.next;
}

async function savedWrite(grid: Grid) {
  await act(async () => {
    await grid.hook.result.current.controller.save();
  });
  const payload = grid.postJson.mock.calls[0]![1] as { writes: Array<Record<string, unknown>> };
  return payload.writes[0];
}

describe("date-and-time cells", () => {
  it("saves an edited custom date and time in the kernel's UTC form", async () => {
    const grid = mountGrid();
    mountEditor(grid, "cf_seen");
    const time = screen.getByLabelText("Seen time (UTC)");
    fireEvent.change(time, { target: { value: "14:30" } });
    fireEvent.keyDown(time, { key: "Enter" });
    expect(await savedWrite(grid)).toMatchObject({
      values: {},
      custom_fields: [{ field_id: "cf_seen", type: "datetime", value: "2026-05-04T14:30:00Z" }],
    });
  });

  it("stages nothing when the editor closes unchanged", () => {
    const grid = mountGrid();
    const { stopEditing } = mountEditor(grid, "cf_seen");
    fireEvent.keyDown(screen.getByLabelText("Seen time (UTC)"), { key: "Enter" });
    expect(stopEditing).toHaveBeenCalled();
    expect(grid.hook.result.current.controller.dirtyCount).toBe(0);
  });

  it("parses pasted date-times and flags text that is not one", () => {
    const grid = mountGrid();
    expect(setCell(grid, "cf_seen", "2026-05-04T09:15:00+02:00")).toBe(true);
    expect(pending(grid, "cf_seen")).toEqual({
      type: "datetime",
      value: "2026-05-04T07:15:00Z",
    });
    expect(setCell(grid, "cf_seen", "2026-06-01 10:00")).toBe(true);
    expect(pending(grid, "cf_seen")).toEqual({
      type: "datetime",
      value: "2026-06-01T10:00:00Z",
    });
    expect(setCell(grid, "checked_at", "next tuesday")).toBe(false);
    expect(grid.hook.result.current.controller.invalidCellCount).toBe(1);
  });

  it("keeps a date-time edit when the grid closes the editor on Tab", async () => {
    const grid = mountGrid();
    const { closeByGrid } = mountEditor(grid, "cf_seen");
    fireEvent.change(screen.getByLabelText("Seen time (UTC)"), { target: { value: "16:45" } });
    closeByGrid();
    expect(await savedWrite(grid)).toMatchObject({
      custom_fields: [{ field_id: "cf_seen", type: "datetime", value: "2026-05-04T16:45:00Z" }],
    });
  });

  it("stages nothing on Tab when the date-time is unchanged", () => {
    const grid = mountGrid();
    const { closeByGrid } = mountEditor(grid, "cf_seen");
    closeByGrid();
    expect(grid.hook.result.current.controller.dirtyCount).toBe(0);
  });

  it("keeps sub-millisecond precision through paste and UTC normalization", () => {
    const grid = mountGrid();
    setCell(grid, "cf_seen", "2026-05-04T12:00:00.123456+02:00");
    expect(pending(grid, "cf_seen")).toEqual({
      type: "datetime",
      value: "2026-05-04T10:00:00.123456Z",
    });
  });

  it("clears an optional custom date and time from the editor's Clear action", async () => {
    const grid = mountGrid();
    mountEditor(grid, "cf_seen");
    await userEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(await savedWrite(grid)).toMatchObject({ clear_custom_fields: ["cf_seen"] });
  });

  it("refuses to clear a required date and time and offers no Clear", () => {
    const grid = mountGrid();
    expect(setCell(grid, "checked_at", "")).toBe(false);
    expect(grid.hook.result.current.controller.dirtyCount).toBe(0);
    expect(grid.hook.result.current.controller.invalidCellCount).toBe(1);
    mountEditor(grid, "checked_at");
    expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
  });
});

describe("list-of-text cells", () => {
  it("saves an edited custom list from the chip editor", async () => {
    const grid = mountGrid();
    mountEditor(grid, "cf_tags");
    await userEvent.click(screen.getByRole("button", { name: "Remove outdoor" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Add to Tags" }), "north{Enter}");
    await userEvent.keyboard("{Enter}");
    expect(await savedWrite(grid)).toMatchObject({
      values: {},
      custom_fields: [{ field_id: "cf_tags", type: "text_list", value: ["priority", "north"] }],
    });
  });

  it("clears a custom list emptied in the editor", async () => {
    const grid = mountGrid();
    mountEditor(grid, "cf_tags");
    await userEvent.click(screen.getByRole("button", { name: "Remove outdoor" }));
    await userEvent.click(screen.getByRole("button", { name: "Remove priority" }));
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(await savedWrite(grid)).toMatchObject({ clear_custom_fields: ["cf_tags"] });
  });

  it("keeps a list edit, typed text included, when the grid closes the editor on Tab", async () => {
    const grid = mountGrid();
    const { closeByGrid } = mountEditor(grid, "cf_tags");
    await userEvent.click(screen.getByRole("button", { name: "Remove outdoor" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Add to Tags" }), "north");
    closeByGrid();
    expect(await savedWrite(grid)).toMatchObject({
      custom_fields: [{ field_id: "cf_tags", type: "text_list", value: ["priority", "north"] }],
    });
  });

  it("saves a pasted list without repeated items", async () => {
    const grid = mountGrid();
    setCell(grid, "cf_tags", "north, south\nnorth, south, east");
    expect(await savedWrite(grid)).toMatchObject({
      custom_fields: [
        { field_id: "cf_tags", type: "text_list", value: ["north", "south", "east"] },
      ],
    });
  });

  it("clears an optional custom list from the editor's Clear action", async () => {
    const grid = mountGrid();
    mountEditor(grid, "cf_tags");
    await userEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(await savedWrite(grid)).toMatchObject({ clear_custom_fields: ["cf_tags"] });
  });

  it("splits pasted lists and clears an optional declared list on an empty paste", async () => {
    const grid = mountGrid();
    expect(setCell(grid, "codes", "X1, X2\nX3")).toBe(true);
    expect(pending(grid, "codes")).toEqual({ type: "text_list", value: ["X1", "X2", "X3"] });
    expect(setCell(grid, "labels", " ")).toBe(true);
    expect(await savedWrite(grid)).toMatchObject({
      values: { codes: { type: "text_list", value: ["X1", "X2", "X3"] } },
      clear_fields: ["labels"],
    });
  });

  it("refuses to clear a required list emptied in the editor", async () => {
    const grid = mountGrid();
    mountEditor(grid, "codes");
    expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Remove X1" }));
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(grid.hook.result.current.controller.dirtyCount).toBe(0);
    expect(grid.hook.result.current.controller.invalidCellCount).toBe(1);
  });
});
