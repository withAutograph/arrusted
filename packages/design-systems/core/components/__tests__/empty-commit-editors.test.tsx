import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vite-plus/test";

import { MoneyRateEditor } from "../editors/money-rate-editor";
import { NumberCellEditor } from "../editors/number-cell-editor";
import type { EditorContext } from "../editors/protocol";

function context(type: string, required?: boolean): EditorContext {
  return {
    rowKey: { type: "record_id", value: "r-1" },
    fieldId: "f",
    fieldType: { type, label: "Amount", ...(required === undefined ? {} : { required }) },
  };
}

describe("emptying number and money editors", () => {
  it("commits an empty number for an optional field", async () => {
    const onCommit = vi.fn();
    render(
      <NumberCellEditor.Component
        initialValue="82"
        context={context("number", false)}
        onCommit={onCommit}
        onCancel={vi.fn()}
      />,
    );
    await userEvent.clear(screen.getByRole("textbox", { name: "Amount" }));
    await userEvent.keyboard("{Enter}");
    expect(onCommit).toHaveBeenCalledWith("");
  });

  it("keeps rejecting an empty number when the field is not marked optional", async () => {
    const onCommit = vi.fn();
    render(
      <NumberCellEditor.Component
        initialValue="82"
        context={context("number")}
        onCommit={onCommit}
        onCancel={vi.fn()}
      />,
    );
    await userEvent.clear(screen.getByRole("textbox", { name: "Amount" }));
    await userEvent.keyboard("{Enter}");
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByText("Enter a valid number.")).toBeTruthy();
  });

  it("commits an empty money amount for an optional field", async () => {
    const onCommit = vi.fn();
    const ctx = context("money_rate", false);
    render(
      <MoneyRateEditor.Component
        initialValue={MoneyRateEditor.parse(
          { type: "money_rate", value: { amount: "1200", currency: "USD", period: "annual" } },
          ctx,
        )}
        context={ctx}
        onCommit={onCommit}
        onCancel={vi.fn()}
      />,
    );
    await userEvent.clear(screen.getByRole("textbox", { name: "Amount amount" }));
    await userEvent.keyboard("{Enter}");
    expect(onCommit).toHaveBeenCalledWith({ amount: "", currency: "USD", period: "annual" });
  });
});
