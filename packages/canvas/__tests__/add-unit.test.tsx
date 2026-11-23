import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vite-plus/test";

import type { DataDefinition } from "@autograph/generated-app-runtime/data";

import { AddUnitForm } from "../add-unit";

const field = (id: string, label: string, type: string) => ({
  id,
  name: id,
  label,
  type,
  required: false,
  readOnly: false,
});
const definition = {
  appId: "add-unit",
  formatVersion: 1,
  schemaVersion: "add-unit-1",
  models: [
    {
      id: "m_event",
      name: "event",
      label: "Event",
      relations: [],
      fields: [
        field("f_name", "Name", "text"),
        field("f_day", "Day", "date"),
        field("f_at", "Logged at", "datetime"),
        field("f_amount", "Amount", "number"),
      ],
    },
  ],
} as unknown as DataDefinition;

describe("add unit", () => {
  it("runs a stacked timeline over date columns only (aggregates do not group by datetime)", async () => {
    render(<AddUnitForm definition={definition} onAdd={vi.fn()} onCancel={vi.fn()} />);
    const user = userEvent.setup();
    const form = screen.getByRole("form", { name: "Add to canvas" });
    await user.click(within(form).getByRole("radio", { name: "Chart" }));
    await user.selectOptions(within(form).getByLabelText("Chart"), "stacked_timeline");
    const over = within(form).getByLabelText("Over");
    const choices = within(over)
      .getAllByRole("option")
      .map((option) => option.textContent);
    expect(choices).toContain("Day");
    expect(choices).not.toContain("Logged at");
  });
});
