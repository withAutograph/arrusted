// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { DataTableComposition, type DataTableSpec } from "../DataTable";

afterEach(cleanup);
const config: DataTableSpec = {
  columns: [{ id: "name", label: "Name" }],
  rows: [
    { id: "a", name: "Item Alpha" },
    { id: "b", name: "Item Beta" },
  ],
};

it("keeps selection controlled and supports keyboard navigation without selecting on focus", () => {
  const onRowSelect = vi.fn();
  const { rerender } = render(
    <DataTableComposition
      spec={{ type: "data_table", config }}
      getRowId={(row) => String(row.id)}
      selectedRowId="a"
      onRowSelect={onRowSelect}
    />,
  );
  const first = screen.getByRole("button", { name: "Select record: Item Alpha" });
  const second = screen.getByRole("button", { name: "Select record: Item Beta" });
  expect(first).toHaveAttribute("aria-pressed", "true");
  first.focus();
  fireEvent.keyDown(first, { key: "ArrowDown" });
  expect(second).toHaveFocus();
  expect(onRowSelect).not.toHaveBeenCalled();
  fireEvent.click(second);
  expect(onRowSelect).toHaveBeenCalledWith("b", config.rows[1]);
  expect(first).toHaveAttribute("aria-pressed", "true");
  fireEvent.keyDown(second, { key: "Home" });
  expect(first).toHaveFocus();
  fireEvent.keyDown(first, { key: "End" });
  expect(second).toHaveFocus();
  rerender(
    <DataTableComposition
      spec={{ type: "data_table", config }}
      getRowId={(row) => String(row.id)}
      selectedRowId="b"
      onRowSelect={onRowSelect}
    />,
  );
  expect(second).toHaveFocus();
  expect(second).toHaveAttribute("aria-pressed", "true");
  expect(first).toHaveAttribute("aria-pressed", "false");
});

it("renders an actionable empty-state explanation supplied by the app and a default fallback", () => {
  const { rerender } = render(
    <DataTableComposition spec={{ type: "data_table", config: { ...config, rows: [] } }} />,
  );
  expect(screen.getByText("No rows.")).toBeInTheDocument();
  rerender(
    <DataTableComposition
      spec={{
        type: "data_table",
        config: {
          ...config,
          rows: [],
          emptyLabel: "No matching records. Clear the filter to see all records.",
        },
      }}
    />,
  );
  expect(screen.getByText(/Clear the filter/)).toBeInTheDocument();
});
