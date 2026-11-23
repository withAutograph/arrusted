import { describe, expect, it, vi } from "vite-plus/test";
import { fireEvent, render, screen } from "@testing-library/react";

import type { VisibleRecord } from "@contracts";
import { createEditBuffer } from "@engines/edit-buffer/index";

import { makeDiffCellRenderer } from "../diff-cell-renderer";

const row: VisibleRecord = {
  record_id: "w-1",
  effective_start: "2026-01-01",
  values: { cf_score: { type: "number", value: "82" } },
  custom_fields: [],
};

describe("diff cell renderer", () => {
  it("keeps showing a pending clear when a later edit was rejected", () => {
    const buffer = createEditBuffer().set({ rowKey: "w-1", fieldId: "cf_score" }, null);
    const Renderer = makeDiffCellRenderer({
      buffer,
      priorValueGetter: () => row.values.cf_score,
      invalidMessageGetter: () => "Enter a valid number.",
      onRevert: () => undefined,
      formatValue: (value) => (value == null ? "" : String(value)),
    });
    render(<Renderer data={row} value="82" valueFormatted="82" colDef={{ colId: "cf_score" }} />);

    expect(screen.getByText("Cleared")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a valid number.");
  });
});

describe("cell pins", () => {
  const renderer = (cellPin?: Parameters<typeof makeDiffCellRenderer>[0]["cellPin"]) =>
    makeDiffCellRenderer({
      buffer: createEditBuffer(),
      priorValueGetter: () => row.values.cf_score,
      onRevert: () => undefined,
      formatValue: (value) => (value == null ? "" : String(value)),
      ...(cellPin ? { cellPin } : {}),
    });

  it("renders the host's pin beside the value and opens it; the grid never sees the click", () => {
    const onOpen = vi.fn();
    const Renderer = renderer((rowKey, fieldId) =>
      rowKey === "w-1" && fieldId === "cf_score"
        ? { label: "2", ariaLabel: "2 threads on Score", count: 2, onOpen }
        : undefined,
    );
    const { container } = render(
      <Renderer data={row} value="82" valueFormatted="82" colDef={{ colId: "cf_score" }} />,
    );
    // AG Grid listens natively on the cell, below React's root listener.
    const seenByGrid: string[] = [];
    for (const type of ["click", "dblclick", "mousedown"])
      container.addEventListener(type, () => seenByGrid.push(type));
    expect(screen.getByText("82")).toBeInTheDocument();
    const pin = screen.getByRole("button", { name: "2 threads on Score" });
    fireEvent.mouseDown(pin);
    fireEvent.click(pin);
    fireEvent.doubleClick(pin);
    expect(onOpen).toHaveBeenCalledOnce();
    expect(seenByGrid).toEqual([]);
    // The rest of the cell still reaches the grid.
    fireEvent.click(screen.getByText("82"));
    expect(seenByGrid).toEqual(["click"]);
  });

  it("renders exactly as before without a pin (no-op case)", () => {
    const plain = render(<Renderer82 Renderer={renderer()} />).container.innerHTML;
    const unpinned = render(<Renderer82 Renderer={renderer(() => undefined)} />).container
      .innerHTML;
    expect(unpinned).toBe(plain);
    expect(plain).not.toContain("ag-cell-pin");
  });

  it('titles a staged cell\'s "was …" beside a pin, where it may be cut short', () => {
    const staged = (cellPin?: Parameters<typeof makeDiffCellRenderer>[0]["cellPin"]) =>
      makeDiffCellRenderer({
        buffer: createEditBuffer().set(
          { rowKey: "w-1", fieldId: "cf_score" },
          { type: "number", value: "90" },
        ),
        priorValueGetter: () => row.values.cf_score,
        onRevert: () => undefined,
        formatValue: (value) => (value == null ? "" : String(value)),
        ...(cellPin ? { cellPin } : {}),
      });
    const Pinned = staged(() => ({ label: "1", ariaLabel: "1 thread", count: 1, onOpen: vi.fn() }));
    const pinned = render(
      <Pinned data={row} value="82" valueFormatted="82" colDef={{ colId: "cf_score" }} />,
    );
    expect(pinned.container.querySelector(".ag-diff-was")).toHaveAttribute("title", "was 82");
    pinned.unmount();
    const Plain = staged();
    const plain = render(
      <Plain data={row} value="82" valueFormatted="82" colDef={{ colId: "cf_score" }} />,
    );
    expect(plain.container.querySelector(".ag-diff-was")).not.toHaveAttribute("title");
  });
});

describe("cell note actions", () => {
  it("runs the note's action from its button; the grid never sees the click", () => {
    const onSelect = vi.fn();
    const Renderer = makeDiffCellRenderer({
      buffer: createEditBuffer(),
      priorValueGetter: () => row.values.cf_score,
      onRevert: () => undefined,
      formatValue: (value) => (value == null ? "" : String(value)),
      cellNote: () => ({
        text: "agent replaced your edit (was 80)",
        action: { label: "Restore yours", ariaLabel: "Restore your Score", onSelect },
      }),
    });
    const { container } = render(<Renderer82 Renderer={Renderer} />);
    const seenByGrid: string[] = [];
    for (const type of ["click", "dblclick", "mousedown"])
      container.addEventListener(type, () => seenByGrid.push(type));
    expect(screen.getByText(/agent replaced your edit \(was 80\)/u)).toBeInTheDocument();
    const action = screen.getByRole("button", { name: "Restore your Score" });
    fireEvent.mouseDown(action);
    fireEvent.click(action);
    fireEvent.doubleClick(action);
    expect(onSelect).toHaveBeenCalledOnce();
    expect(seenByGrid).toEqual([]);
  });
});

function Renderer82({ Renderer }: { Renderer: ReturnType<typeof makeDiffCellRenderer> }) {
  return <Renderer data={row} value="82" valueFormatted="82" colDef={{ colId: "cf_score" }} />;
}

describe("cell marks", () => {
  const renderer = (cellMark?: Parameters<typeof makeDiffCellRenderer>[0]["cellMark"]) =>
    makeDiffCellRenderer({
      buffer: createEditBuffer(),
      priorValueGetter: () => row.values.cf_score,
      onRevert: () => undefined,
      formatValue: (value) => (value == null ? "" : String(value)),
      ...(cellMark ? { cellMark } : {}),
    });

  it("shows a quiet mark beside the value that names itself on hover; clicks reach the grid", () => {
    const Renderer = renderer((rowKey, fieldId) =>
      rowKey === "w-1" && fieldId === "cf_score"
        ? { label: "draft", title: "In draft #12" }
        : undefined,
    );
    const { container } = render(
      <Renderer data={row} value="82" valueFormatted="82" colDef={{ colId: "cf_score" }} />,
    );
    const seenByGrid: string[] = [];
    container.addEventListener("click", () => seenByGrid.push("click"));
    expect(screen.getByText("82")).toBeInTheDocument();
    const mark = screen.getByTitle("In draft #12");
    expect(mark).toHaveTextContent("draft");
    expect(screen.queryByRole("button")).toBeNull();
    fireEvent.click(mark);
    expect(seenByGrid).toEqual(["click"]);
  });

  it("renders exactly as before without a mark (no-op case)", () => {
    const Plain = renderer();
    const Unmarked = renderer(() => undefined);
    const plain = render(
      <Plain data={row} value="82" valueFormatted="82" colDef={{ colId: "cf_score" }} />,
    ).container.innerHTML;
    const unmarked = render(
      <Unmarked data={row} value="82" valueFormatted="82" colDef={{ colId: "cf_score" }} />,
    ).container.innerHTML;
    expect(unmarked).toBe(plain);
    expect(plain).not.toContain("ag-cell-mark");
  });
});
