// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { useState, type ComponentProps, type ComponentType } from "react";
import type { EditorContext } from "../editors/protocol";
import { PersonPicker } from "../editors/person-picker";
import { RelationPicker } from "../editors/relation-picker";

afterEach(cleanup);

const context: EditorContext = {
  rowKey: { type: "record_id", value: "row" },
  fieldId: "owner",
  fieldType: {
    type: "relation",
    label: "Owner",
    relationOptions: [
      { key: { type: "record_id", value: "one" }, label: "One" },
      { key: { type: "record_id", value: "two" }, label: "Two" },
    ],
  },
};

describe.each([
  ["PersonPicker", PersonPicker.Component],
  ["RelationPicker", RelationPicker.Component],
])("%s adapter", (_name, Component) => {
  it("retains Escape cancellation", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(
      <Component initialValue={null} context={context} onCommit={() => {}} onCancel={onCancel} />,
    );
    await user.type(screen.getByRole("combobox", { name: "Owner" }), "{Escape}");
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("commits the active option and navigates on Tab", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    const onNavigate = vi.fn();
    render(
      <Component
        initialValue={null}
        context={context}
        onCommit={onCommit}
        onCancel={() => {}}
        onNavigate={onNavigate}
      />,
    );
    const input = screen.getByRole("combobox", { name: "Owner" });
    await user.click(input);
    await user.keyboard("{ArrowDown}{Tab}");
    expect(onCommit).toHaveBeenCalledWith({ type: "record_id", value: "two" });
    expect(onNavigate).toHaveBeenCalledWith("next");
  });

  it("does not commit an untouched empty picker on Tab or Enter", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    const onNavigate = vi.fn();
    const onCancel = vi.fn();
    render(
      <Component
        initialValue={null}
        context={context}
        onCommit={onCommit}
        onCancel={onCancel}
        onNavigate={onNavigate}
      />,
    );

    await user.keyboard("{Enter}{Tab}");
    expect(onCommit).not.toHaveBeenCalled();
    expect(onNavigate).toHaveBeenCalledWith("next");
  });

  it("commits an initial query match on Enter and reports a missing match", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    const QueryComponent = Component as ComponentType<
      ComponentProps<typeof Component> & { initialQuery?: string }
    >;
    const { unmount } = render(
      <QueryComponent
        initialValue={null}
        initialQuery="Two"
        context={context}
        onCommit={onCommit}
        onCancel={() => {}}
      />,
    );
    await user.keyboard("{Enter}");
    expect(onCommit).toHaveBeenCalledWith({ type: "record_id", value: "two" });
    unmount();

    render(
      <QueryComponent
        initialValue={null}
        initialQuery="Missing"
        context={context}
        onCommit={() => {}}
        onCancel={() => {}}
      />,
    );
    await user.keyboard("{Enter}");
    expect(screen.getByRole("alert")).toHaveTextContent(/select/i);
  });

  it("commits a query match that arrives asynchronously on Tab", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    function AsyncOptionsPicker() {
      const [loaded, setLoaded] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setLoaded(true)}>
            Load
          </button>
          <Component
            initialValue={null}
            context={{
              ...context,
              fieldType: {
                ...context.fieldType,
                relationOptions: loaded ? context.fieldType.relationOptions : [],
              },
            }}
            onCommit={onCommit}
            onCancel={() => {}}
            onNavigate={() => {}}
          />
        </>
      );
    }
    render(<AsyncOptionsPicker />);
    await user.type(screen.getByRole("combobox", { name: "Owner" }), "Two");
    await user.click(screen.getByRole("button", { name: "Load" }));
    screen.getByRole("combobox", { name: "Owner" }).focus();
    await user.keyboard("{Tab}");
    expect(onCommit).toHaveBeenCalledWith({ type: "record_id", value: "two" });
  });

  it("preserves an unavailable current value until the user highlights a replacement", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    const onNavigate = vi.fn();
    const { unmount } = render(
      <Component
        initialValue={{ type: "record_id", value: "missing" }}
        context={context}
        onCommit={onCommit}
        onCancel={() => {}}
        onNavigate={onNavigate}
      />,
    );

    await user.keyboard("{Enter}{Tab}");
    expect(onCommit).not.toHaveBeenCalled();
    unmount();

    render(
      <Component
        initialValue={{ type: "record_id", value: "missing" }}
        context={context}
        onCommit={onCommit}
        onCancel={() => {}}
        onNavigate={onNavigate}
      />,
    );
    await user.click(screen.getByRole("combobox", { name: "Owner" }));
    await user.keyboard("{ArrowDown}{Tab}");
    expect(onCommit).toHaveBeenCalledWith({ type: "record_id", value: "two" });
  });
});
