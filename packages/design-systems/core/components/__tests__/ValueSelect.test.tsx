import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vite-plus/test";

import type { EditorContext, ValueSelectOption } from "../editors/protocol";
import { ValueSelect } from "../editors/value-select";

function context(valueOptions: ValueSelectOption[]): EditorContext {
  return {
    rowKey: { type: "record_id", value: "rec-1" },
    fieldId: "status",
    fieldType: { type: "text", label: "Status", valueOptions },
  };
}

describe("ValueSelect", () => {
  it("renders fixed vocabulary options", () => {
    render(
      <ValueSelect.Component
        initialValue="Open"
        context={context(["Open", "Closed"])}
        onCommit={() => {}}
        onCancel={() => {}}
      />,
    );

    expect(screen.getByRole("listbox", { name: "Status" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Open" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("option", { name: "Closed" })).toHaveAttribute(
      "aria-selected",
      "false",
    );
  });

  it("commits a clicked option", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();

    render(
      <ValueSelect.Component
        initialValue="Open"
        context={context(["Open", "Closed"])}
        onCommit={onCommit}
        onCancel={() => {}}
      />,
    );

    await user.click(screen.getByRole("option", { name: "Closed" }));

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("Closed");
  });

  it("renders labels while committing values for labeled options", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();

    render(
      <ValueSelect.Component
        initialValue="active"
        context={context([
          { value: "active", label: "Active" },
          { value: "on_leave", label: "On leave" },
        ])}
        onCommit={onCommit}
        onCancel={() => {}}
      />,
    );

    expect(screen.getByRole("option", { name: "Active" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("option", { name: "on_leave" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("option", { name: "On leave" }));

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("on_leave");
  });

  it("commits the active option on Enter after arrow navigation", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();

    render(
      <ValueSelect.Component
        initialValue="Open"
        context={context(["Open", "Closed"])}
        onCommit={onCommit}
        onCancel={() => {}}
      />,
    );

    screen.getByRole("listbox", { name: "Status" }).focus();
    await user.keyboard("{ArrowDown}{Enter}");

    expect(screen.getByRole("option", { name: "Open" })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("option", { name: "Closed" })).toHaveAttribute("aria-selected", "true");
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("Closed");
  });

  it("does not commit the first option on immediate Enter from an empty value", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();

    render(
      <ValueSelect.Component
        initialValue=""
        context={context(["Open", "Closed"])}
        onCommit={onCommit}
        onCancel={() => {}}
      />,
    );

    screen.getByRole("listbox", { name: "Status" }).focus();
    expect(screen.getByRole("option", { name: "Open" })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("option", { name: "Closed" })).toHaveAttribute(
      "aria-selected",
      "false",
    );

    await user.keyboard("{Enter}");
    expect(onCommit).not.toHaveBeenCalled();

    await user.keyboard("{ArrowDown}{Enter}");
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("Open");
  });

  it("cancels on Escape", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();

    render(
      <ValueSelect.Component
        initialValue="Open"
        context={context(["Open", "Closed"])}
        onCommit={() => {}}
        onCancel={onCancel}
      />,
    );

    screen.getByRole("listbox", { name: "Status" }).focus();
    await user.keyboard("{Escape}");

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("prepends an out-of-vocabulary current value", () => {
    render(
      <ValueSelect.Component
        initialValue="Legacy"
        context={context(["Open", "Closed"])}
        onCommit={() => {}}
        onCancel={() => {}}
      />,
    );

    const options = screen.getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual(["Legacy", "Open", "Closed"]);
    expect(options[0]).toHaveAttribute("aria-selected", "true");
  });

  it("omits aria-activedescendant when there are no options", () => {
    render(
      <ValueSelect.Component
        initialValue=""
        context={context([])}
        onCommit={() => {}}
        onCancel={() => {}}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("No options");
    expect(screen.getByRole("listbox", { name: "Status" })).not.toHaveAttribute(
      "aria-activedescendant",
    );
  });
});
