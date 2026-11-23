// @vitest-environment jsdom

// Per-row editor defaults: a host may say which currency and period an EMPTY
// money cell starts on (e.g. the row's pay band). The editor shows them in its
// selects; a stored value keeps its own unit; grids that do not opt in start
// an empty value on the field type's first currency and period, as before.

import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { ReactElement } from "react";

import type { FieldValue, VisibleRecord } from "@contracts";

import { MoneyRateCellEditorAdapter } from "../cell-editors/money-rate-editor";
import type { EditorDefaults } from "../schema-columns";

afterEach(cleanup);

const row: VisibleRecord = {
  record_id: "w-1",
  effective_start: "2026-01-01",
  values: {},
  custom_fields: [],
};

function open(
  value: FieldValue | null,
  editorDefaults?: (row: VisibleRecord) => EditorDefaults | undefined,
) {
  const setDataValue = vi.fn();
  const props = {
    value,
    data: row,
    column: { getColId: () => "salary" },
    colDef: { headerName: "Salary" },
    node: { setDataValue },
    api: { stopEditing: vi.fn() },
    fieldType: { type: "money_rate", label: "Salary", required: false },
    editorDefaults,
  };
  const Adapter = MoneyRateCellEditorAdapter as unknown as (p: typeof props) => ReactElement;
  render(<Adapter {...props} />);
  return { setDataValue };
}

// The currency and period selects, as shown.
const shownUnit = () =>
  screen
    .getAllByRole("combobox")
    .map((select) => (select as HTMLSelectElement).selectedOptions[0]?.textContent);

describe("money editor defaults per row", () => {
  it("starts an empty value on the row's currency and period, and commits in them", async () => {
    const defaults = vi.fn(() => ({ currency: "EUR", period: "monthly" }));
    const { setDataValue } = open(null, defaults);
    expect(defaults).toHaveBeenCalledWith(row);
    expect(shownUnit()).toEqual(["EUR", "mo"]);

    await userEvent.type(screen.getByRole("textbox", { name: "Salary amount" }), "6000{Enter}");
    expect(setDataValue).toHaveBeenCalledWith(
      expect.anything(),
      { type: "money_rate", value: { amount: "6000", currency: "EUR", period: "monthly" } },
      "edit",
    );
  });

  it("offers a default currency the field type does not list", () => {
    // Only the currency is named: the period keeps the editor's own default.
    open(null, () => ({ currency: "JPY" }));
    expect(shownUnit()).toEqual(["JPY", "yr"]);
  });

  it("keeps a stored value's own unit", () => {
    const defaults = vi.fn(() => ({ currency: "EUR", period: "monthly" }));
    open(
      { type: "money_rate", value: { amount: "90000", currency: "GBP", period: "annual" } },
      defaults,
    );
    expect(defaults).not.toHaveBeenCalled();
    expect(shownUnit()).toEqual(["GBP", "yr"]);
  });

  it("without editor defaults, an empty value starts as it always has", () => {
    open(null);
    expect(shownUnit()).toEqual(["USD", "yr"]);
  });
});
