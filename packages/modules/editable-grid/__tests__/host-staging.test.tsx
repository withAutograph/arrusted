// @vitest-environment jsdom

// Host-owned staging: a host that keeps pending edits itself (e.g. in a
// session) mounts the real grid over its baseline rows. Edits and reverts go
// to the host instead of the grid's buffer, the host's pending set renders as
// dirty cells with their prior value and who staged them, and no row meta
// strip appears.

import { act, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import type { GridApi } from "ag-grid-community";

import type { Schema, VisibleRecord } from "@contracts";

import {
  bootstrapAgGrid,
  EditableRowVersionGrid,
  useEditableRowVersionGridPreview,
  type CellNote,
  type HostStagedCell,
  type HostStaging,
} from "../index";

bootstrapAgGrid();

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
        { id: "label", label: "Label", type: "text", required: false },
        { id: "owner", label: "Owner", type: "relation", required: false, target_model: "person" },
      ],
    },
    { id: "person", kind: "entity", label: "Person", fields: [] },
  ],
  change_types: [],
};

const text = (value: string) => ({ type: "text" as const, value });
const ROWS: VisibleRecord[] = [
  {
    record_id: "w-1",
    effective_start: "2026-01-01",
    values: { name: text("North"), label: text("Alpha") },
    custom_fields: [],
  },
  {
    record_id: "w-2",
    effective_start: "2026-01-01",
    values: { name: text("South"), label: text("Beta") },
    custom_fields: [],
  },
];
const OPTIONS = {
  person: [
    { key: { type: "record_id" as const, value: "p-1" }, label: "Alice Bluth" },
    { key: { type: "record_id" as const, value: "p-2" }, label: "Bob Loblaw" },
  ],
};

type Sinks = Pick<HostStaging, "onStage" | "onRevert">;

function mount(options: {
  pending: HostStagedCell[];
  sinks: Sinks;
  cellNote?: (rowKey: string, fieldId: string) => CellNote | undefined;
  rowReadOnly?: (rowKey: string) => boolean;
}) {
  let api: GridApi | null = null;
  let controller: ReturnType<typeof useEditableRowVersionGridPreview>["controller"] | null = null;
  let setPending: (next: HostStagedCell[]) => void = () => {};
  type NoteGetter = (rowKey: string, fieldId: string) => CellNote | undefined;
  let setCellNote: (next: NoteGetter | undefined) => void = () => {};
  let columnDefs: unknown = null;

  const onCellClicked = vi.fn();
  function Harness() {
    const [pending, update] = useState(options.pending);
    setPending = update;
    const [cellNote, updateNote] = useState(() => options.cellNote);
    setCellNote = (next) => updateNote(() => next);
    const grid = useEditableRowVersionGridPreview({
      modelId: "widget",
      asOf: "2026-10-19",
      scope: { appId: "demo", customerId: "demo" },
      rows: ROWS,
      schema: SCHEMA,
      model: "widget",
      relationOptionsByModel: OPTIONS,
      hostStaging: { pending, ...options.sinks },
      cellNote,
      ...(options.rowReadOnly ? { rowReadOnly: options.rowReadOnly } : {}),
    });
    controller = grid.controller;
    columnDefs = grid.surfaceProps.columnDefs;
    return (
      <div style={{ width: 1200, height: 600 }}>
        <EditableRowVersionGrid
          {...grid.surfaceProps}
          onCellClicked={onCellClicked}
          onGridReady={(event) => {
            api = event.api as unknown as GridApi;
            grid.surfaceProps.onGridReady(event);
          }}
        />
      </div>
    );
  }
  render(<Harness />);
  return {
    api: () => api!,
    controller: () => controller!,
    columnDefs: () => columnDefs,
    onCellClicked,
    setPending: (next: HostStagedCell[]) => act(() => setPending(next)),
    setCellNote: (next: NoteGetter | undefined) => act(() => setCellNote(next)),
  };
}

const cell = (rowId: string, colId: string) =>
  document.querySelector<HTMLElement>(`[row-id="${rowId}"] [col-id="${colId}"]`)!;

describe("host-owned staging", () => {
  it("hands a cell edit to the host and buffers nothing itself", async () => {
    const sinks = { onStage: vi.fn(), onRevert: vi.fn() };
    const grid = mount({ pending: [], sinks });
    await waitFor(() => expect(screen.getByText("North")).toBeInTheDocument());

    act(() => {
      grid.api().getRowNode("w-1")!.setDataValue("label", "Gamma", "edit");
    });

    expect(sinks.onStage).toHaveBeenCalledWith({
      rowKey: "w-1",
      fieldId: "label",
      value: text("Gamma"),
    });
    // The host has not staged it yet: nothing is dirty, but the cell shows the
    // edit rather than flicking back to the baseline while the host stages it.
    expect(grid.controller().dirtyCount).toBe(0);
    expect(cell("w-1", "label")).toHaveTextContent("Gamma");
  });

  it("routes a picked link option to the host", async () => {
    const sinks = { onStage: vi.fn(), onRevert: vi.fn() };
    const grid = mount({ pending: [], sinks });
    await waitFor(() => expect(screen.getByText("North")).toBeInTheDocument());
    act(() => {
      grid.api().setGridOption("popupParent", document.body);
      grid.api().startEditingCell({ rowIndex: 0, colKey: "owner" });
    });
    await userEvent.setup().click(await screen.findByRole("option", { name: "Bob Loblaw" }));
    await waitFor(() =>
      expect(sinks.onStage).toHaveBeenCalledWith({
        rowKey: "w-1",
        fieldId: "owner",
        value: { type: "relation", value: { type: "record_id", value: "p-2" } },
      }),
    );
  });

  it("shows the host's pending set with its prior value and agent marker, and no meta strip", async () => {
    const sinks = { onStage: vi.fn(), onRevert: vi.fn() };
    const grid = mount({
      pending: [
        {
          rowKey: "w-1",
          fieldId: "label",
          value: text("Gamma"),
          prior: text("Draft"),
          source: "agent",
        },
        // A user edit on the same row as the agent's keeps its own (unmarked) source.
        { rowKey: "w-1", fieldId: "name", value: text("North 2"), prior: text("North") },
        { rowKey: "w-2", fieldId: "label", value: text("Delta"), prior: text("Beta") },
      ],
      sinks,
    });
    await waitFor(() => expect(cell("w-1", "label")).toHaveTextContent("Gamma"));

    // The prior is the host's (not the row's "Alpha"), and the agent's edit is marked.
    expect(cell("w-1", "label")).toHaveTextContent("Gammaagent was Draft");
    expect(cell("w-1", "label").querySelector("[data-edit-source='agent']")).not.toBeNull();
    expect(cell("w-2", "label")).toHaveTextContent("Deltawas Beta");
    expect(cell("w-2", "label").querySelector("[data-agent-marker]")).toBeNull();
    expect(cell("w-1", "name")).toHaveTextContent("North 2was North");
    expect(cell("w-1", "name").querySelector("[data-agent-marker]")).toBeNull();
    expect(grid.controller().dirtyCount).toBe(3);
    expect(grid.controller().pendingChangesByRow.get("w-1")?.fieldChanges).toEqual([
      { fieldId: "label", prior: text("Draft"), next: text("Gamma") },
      { fieldId: "name", prior: text("North"), next: text("North 2") },
    ]);
    // Effective date and change type belong to the host: no full-width meta rows.
    expect(document.querySelector(".ag-full-width-row")).toBeNull();

    // Reverting asks the host; the cell stays until the host's set changes.
    await userEvent
      .setup()
      .click(within(cell("w-2", "label")).getByRole("button", { name: "Revert", hidden: true }));
    expect(sinks.onRevert).toHaveBeenCalledWith({ rowKey: "w-2", fieldId: "label" });
    expect(cell("w-2", "label")).toHaveTextContent("Delta");

    grid.setPending([]);
    await waitFor(() => expect(cell("w-2", "label")).toHaveTextContent("Beta"));
    expect(grid.controller().dirtyCount).toBe(0);
  });

  it("shows a refused edit's cell at the host's value again once the stage settles", async () => {
    let refuse = () => {};
    const sinks = {
      onStage: vi.fn(() => new Promise<void>((resolve) => (refuse = resolve))),
      onRevert: vi.fn(),
    };
    const grid = mount({ pending: [], sinks });
    await waitFor(() => expect(screen.getByText("North")).toBeInTheDocument());
    act(() => {
      grid.api().getRowNode("w-1")!.setDataValue("label", "Gamma", "edit");
    });
    expect(cell("w-1", "label")).toHaveTextContent("Gamma");
    // The host refuses it: its pending set and rows stay as they were.
    await act(async () => refuse());
    await waitFor(() => expect(cell("w-1", "label")).toHaveTextContent(/^Alpha$/u));
  });

  it("keeps a settling cell's staged value with a spinner instead of its revert button", async () => {
    const sinks = { onStage: vi.fn(), onRevert: vi.fn() };
    const grid = mount({
      pending: [{ rowKey: "w-2", fieldId: "label", value: text("Delta"), prior: text("Beta") }],
      sinks,
    });
    await waitFor(() => expect(cell("w-2", "label")).toHaveTextContent("Deltawas Beta"));
    expect(cell("w-2", "label").querySelector("[data-settling]")).toBeNull();

    grid.setPending([
      {
        rowKey: "w-2",
        fieldId: "label",
        value: text("Delta"),
        prior: text("Beta"),
        settling: true,
      },
    ]);
    await waitFor(() =>
      expect(
        within(cell("w-2", "label")).getByRole("status", { name: "Updating" }),
      ).toBeInTheDocument(),
    );
    expect(cell("w-2", "label")).toHaveTextContent("Deltawas Beta");
    expect(
      within(cell("w-2", "label")).queryByRole("button", { name: "Revert", hidden: true }),
    ).toBeNull();

    grid.setPending([]);
    await waitFor(() => expect(cell("w-2", "label")).toHaveTextContent(/^Beta$/u));
  });

  it("stages an edit back to the host's prior: the host decides, only Restore unstages", async () => {
    const sinks = { onStage: vi.fn(), onRevert: vi.fn() };
    const grid = mount({
      pending: [{ rowKey: "w-1", fieldId: "label", value: text("Gamma"), prior: text("Draft") }],
      sinks,
    });
    await waitFor(() => expect(cell("w-1", "label")).toHaveTextContent("Gamma"));
    act(() => {
      grid.api().getRowNode("w-1")!.setDataValue("label", "Draft", "edit");
    });
    expect(sinks.onStage).toHaveBeenCalledWith({
      rowKey: "w-1",
      fieldId: "label",
      value: text("Draft"),
    });
    expect(sinks.onRevert).not.toHaveBeenCalled();
  });

  it("hands over an edit back to the shown value while the host is still staging the first", async () => {
    // The host stages asynchronously; its pending set catches up as each stage settles.
    const settles: (() => void)[] = [];
    const sinks = {
      onStage: vi.fn(
        (_edit: Parameters<HostStaging["onStage"]>[0]) =>
          new Promise<void>((resolve) => settles.push(resolve)),
      ),
      onRevert: vi.fn(),
    };
    const grid = mount({ pending: [], sinks });
    await waitFor(() => expect(cell("w-1", "label")).toHaveTextContent("Alpha"));
    act(() => {
      grid.api().getRowNode("w-1")!.setDataValue("label", "Gamma", "edit");
      grid.api().getRowNode("w-1")!.setDataValue("label", "Alpha", "edit");
    });
    expect(sinks.onStage.mock.calls.map(([edit]) => edit)).toEqual([
      { rowKey: "w-1", fieldId: "label", value: text("Gamma") },
      { rowKey: "w-1", fieldId: "label", value: text("Alpha") },
    ]);

    // An empty link set and cleared before the host shows it: the clear is handed over too.
    const link = { type: "relation" as const, value: { type: "record_id" as const, value: "p-1" } };
    act(() => {
      grid.api().getRowNode("w-2")!.setDataValue("owner", link, "edit");
      grid.api().getRowNode("w-2")!.setDataValue("owner", null, "edit");
    });
    expect(sinks.onStage.mock.calls.slice(2).map(([edit]) => edit)).toEqual([
      { rowKey: "w-2", fieldId: "owner", value: link },
      { rowKey: "w-2", fieldId: "owner", value: null },
    ]);

    // Once every stage settles, an edit to the shown value is a no-op again.
    await act(async () => {
      for (const settle of settles) settle();
    });
    act(() => {
      grid.api().getRowNode("w-1")!.setDataValue("label", "Alpha", "edit");
    });
    expect(sinks.onStage).toHaveBeenCalledTimes(4);
  });

  it("keeps the same columns while the host's pending set changes, and repaints its cells", async () => {
    const sinks = { onStage: vi.fn(), onRevert: vi.fn() };
    const pending: HostStagedCell[] = [
      { rowKey: "w-1", fieldId: "label", value: text("Gamma"), prior: text("Alpha") },
    ];
    const grid = mount({ pending, sinks });
    await waitFor(() => expect(cell("w-1", "label")).toHaveTextContent("Gamma"));
    const before = grid.columnDefs();
    grid.setPending(pending.map((entry) => ({ ...entry })));
    expect(grid.columnDefs()).toBe(before);
    // A changed set keeps them too (a rebuild would close an open editor).
    grid.setPending([
      { ...pending[0]!, value: text("Omega") },
      {
        rowKey: "w-2",
        fieldId: "label",
        value: text("Delta"),
        prior: text("Beta"),
        source: "agent",
      },
    ]);
    expect(grid.columnDefs()).toBe(before);
    await waitFor(() => expect(cell("w-1", "label")).toHaveTextContent("Omegawas Alpha"));
    await waitFor(() => expect(cell("w-2", "label")).toHaveTextContent(/Delta.*agent.*was Beta/u));
  });

  it("shows a host note under a clean cell, as an alert when it is an error", async () => {
    const sinks = { onStage: vi.fn(), onRevert: vi.fn() };
    mount({
      pending: [],
      sinks,
      cellNote: (rowKey, fieldId) =>
        rowKey === "w-1" && fieldId === "label"
          ? { text: "in draft #4" }
          : rowKey === "w-2" && fieldId === "label"
            ? { text: "Not staged", tone: "danger" }
            : undefined,
    });
    await waitFor(() => expect(cell("w-1", "label")).toHaveTextContent("Alphain draft #4"));
    expect(within(cell("w-2", "label")).getByRole("alert")).toHaveTextContent("Not staged");
  });

  it("repaints a new host note without rebuilding the columns", async () => {
    const sinks = { onStage: vi.fn(), onRevert: vi.fn() };
    const grid = mount({ pending: [], sinks, cellNote: () => undefined });
    await waitFor(() => expect(cell("w-1", "label")).toHaveTextContent(/^Alpha$/u));
    const before = grid.columnDefs();
    grid.setCellNote((rowKey, fieldId) =>
      rowKey === "w-1" && fieldId === "label" ? { text: "in draft #4" } : undefined,
    );
    await waitFor(() => expect(cell("w-1", "label")).toHaveTextContent("Alphain draft #4"));
    expect(grid.columnDefs()).toBe(before);
  });

  it("shows why a re-edit of an already-staged cell was rejected, under its was line", async () => {
    const sinks = { onStage: vi.fn(), onRevert: vi.fn() };
    let rejected = false;
    const grid = mount({
      pending: [{ rowKey: "w-1", fieldId: "label", value: text("Gamma"), prior: text("Alpha") }],
      sinks,
      cellNote: (rowKey, fieldId) =>
        rejected && rowKey === "w-1" && fieldId === "label"
          ? { text: "Not staged: Omega. The value was rejected.", tone: "danger" }
          : undefined,
    });
    await waitFor(() => expect(cell("w-1", "label")).toHaveTextContent("Gammawas Alpha"));
    expect(within(cell("w-1", "label")).queryByRole("alert")).toBeNull();

    // The second edit reaches the host, which rejects it and keeps the staged value.
    act(() => {
      grid.api().getRowNode("w-1")!.setDataValue("label", "Omega", "edit");
    });
    expect(sinks.onStage).toHaveBeenCalledWith(
      expect.objectContaining({ rowKey: "w-1", fieldId: "label" }),
    );
    rejected = true;
    grid.setPending([
      {
        rowKey: "w-1",
        fieldId: "label",
        value: text("Gamma"),
        prior: text("Alpha"),
        source: "user",
      },
    ]);
    act(() => grid.api().refreshCells({ force: true }));
    await waitFor(() =>
      expect(within(cell("w-1", "label")).getByRole("alert")).toHaveTextContent(
        "Not staged: Omega. The value was rejected.",
      ),
    );
    // Still the staged value with what it replaced.
    expect(cell("w-1", "label")).toHaveTextContent("Gammawas Alpha");
  });

  it("reports a click on a data cell by row and field", async () => {
    const grid = mount({ pending: [], sinks: { onStage: vi.fn(), onRevert: vi.fn() } });
    await waitFor(() => expect(screen.getByText("South")).toBeInTheDocument());
    await userEvent.setup().click(cell("w-2", "name"));
    expect(grid.onCellClicked).toHaveBeenCalledWith({ rowKey: "w-2", fieldId: "name" });
  });
});

describe("grids without host staging", () => {
  it("render agent-staged edits as before: no agent marker and no source attribute", async () => {
    let api: GridApi | null = null;
    let controller: ReturnType<typeof useEditableRowVersionGridPreview>["controller"] | null = null;
    function Plain() {
      const grid = useEditableRowVersionGridPreview({
        modelId: "widget",
        asOf: "2026-10-19",
        scope: { appId: "demo", customerId: "demo" },
        rows: ROWS,
        schema: SCHEMA,
        model: "widget",
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
    render(<Plain />);
    await waitFor(() => expect(screen.getByText("North")).toBeInTheDocument());
    // An agent stages a label on w-1, then a user edits the same row's name.
    act(() => {
      controller!.stageBulkUpdate({
        rows: [{ rowKey: "w-1" }],
        fieldId: "label",
        value: text("Gamma"),
        bulkGroupId: "agent-run-1",
        sourceKind: "agent",
      });
    });
    act(() => {
      api!.getRowNode("w-1")!.setDataValue("name", "North 2", "edit");
    });
    await waitFor(() => expect(cell("w-1", "label")).toHaveTextContent("Gammawas Alpha"));
    expect(cell("w-1", "name")).toHaveTextContent("North 2was North");
    expect(document.querySelector("[data-agent-marker]")).toBeNull();
    expect(document.querySelector("[data-edit-source]")).toBeNull();
    // No `cellNote`: dirty cells carry no note line either.
    expect(document.querySelector("[data-cell-note]")).toBeNull();
  });
});

describe("rows the host keeps read-only", () => {
  // w-2 is read-only (e.g. a record only a pending draft creates); w-1 is not.
  const readOnly = (rowKey: string) => rowKey === "w-2";

  it("never opens an editor on a read-only row", async () => {
    const sinks = { onStage: vi.fn(), onRevert: vi.fn() };
    const grid = mount({ pending: [], sinks, rowReadOnly: readOnly });
    await waitFor(() => expect(screen.getByText("South")).toBeInTheDocument());
    act(() => grid.api().startEditingCell({ rowIndex: 1, colKey: "label" }));
    expect(grid.api().getEditingCells()).toEqual([]);
    act(() => grid.api().startEditingCell({ rowIndex: 0, colKey: "label" }));
    expect(grid.api().getEditingCells()).toHaveLength(1);
  });

  // Paste, Delete over a range and fill all write only cells AG Grid reports
  // editable (`isCellEditable`), so a read-only row takes none of them. jsdom
  // cannot drive AG Grid's range gestures beyond the focused cell, so this
  // asserts the editability they consult; the gestures are proven in a browser.
  it("reports a read-only row's cells as not editable, and others as editable", async () => {
    const sinks = { onStage: vi.fn(), onRevert: vi.fn() };
    const grid = mount({ pending: [], sinks, rowReadOnly: readOnly });
    await waitFor(() => expect(screen.getByText("South")).toBeInTheDocument());
    for (const field of ["name", "label"]) {
      const column = grid.api().getColumn(field)!;
      expect(column.isCellEditable(grid.api().getRowNode("w-1")!)).toBe(true);
      expect(column.isCellEditable(grid.api().getRowNode("w-2")!)).toBe(false);
    }
    expect(sinks.onStage).not.toHaveBeenCalled();
  });

  it("refuses a value written to a row after it turned read-only", async () => {
    // e.g. an editor opened before the row turned read-only commits late.
    const sinks = { onStage: vi.fn(), onRevert: vi.fn() };
    const grid = mount({ pending: [], sinks, rowReadOnly: readOnly });
    await waitFor(() => expect(screen.getByText("South")).toBeInTheDocument());
    act(() => {
      grid.api().getRowNode("w-2")!.setDataValue("label", "Late", "edit");
      grid.api().getRowNode("w-1")!.setDataValue("label", "Kept", "edit");
    });
    expect(sinks.onStage.mock.calls.map(([edit]) => (edit as { rowKey: string }).rowKey)).toEqual([
      "w-1",
    ]);
  });

  it("without read-only rows every row stays editable (no-op case)", async () => {
    const sinks = { onStage: vi.fn(), onRevert: vi.fn() };
    const grid = mount({ pending: [], sinks });
    await waitFor(() => expect(screen.getByText("South")).toBeInTheDocument());
    const column = grid.api().getColumn("label")!;
    expect(column.isCellEditable(grid.api().getRowNode("w-2")!)).toBe(true);
    act(() => grid.api().getRowNode("w-2")!.setDataValue("label", "Late", "edit"));
    expect(sinks.onStage).toHaveBeenCalledWith(expect.objectContaining({ rowKey: "w-2" }));
  });
});
