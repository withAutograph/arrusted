// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { SearchableListbox } from "../searchable-listbox";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const options = [
  { value: "alpha", label: "Alpha", searchText: "Alpha first" },
  { value: "disabled", label: "Disabled", searchText: "Disabled", disabled: true },
  { value: "beta", label: "Beta", searchText: "Beta second" },
];

function renderListbox(
  overrides: Partial<React.ComponentProps<typeof SearchableListbox<string>>> = {},
) {
  const props: React.ComponentProps<typeof SearchableListbox<string>> = {
    options,
    value: null,
    query: "",
    onQueryChange: () => {},
    onValueChange: () => {},
    getOptionKey: (value) => value,
    ariaLabel: "Project",
    placeholder: "Search projects",
    autoFocus: true,
    ...overrides,
  };
  return render(<SearchableListbox {...props} />);
}

describe("SearchableListbox", () => {
  it("keeps input focus while a controlled query grows beyond one character", async () => {
    const user = userEvent.setup();
    function ControlledListbox() {
      const [query, setQuery] = useState("");
      return (
        <SearchableListbox
          options={options}
          value={null}
          query={query}
          onQueryChange={setQuery}
          onValueChange={() => {}}
          getOptionKey={(value) => value}
          ariaLabel="Project"
          placeholder="Search projects"
        />
      );
    }
    render(<ControlledListbox />);
    const combobox = screen.getByRole("combobox", { name: "Project" });
    await user.type(combobox, "beta");
    expect(combobox).toHaveValue("beta");
    expect(combobox).toHaveFocus();
  });

  it("reveals options only after the input is focused", async () => {
    const user = userEvent.setup();
    renderListbox({ autoFocus: false });
    const combobox = screen.getByRole("combobox", { name: "Project" });
    expect(combobox).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("listbox", { name: "Project options" })).not.toBeInTheDocument();

    await user.click(combobox);
    expect(combobox).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("listbox", { name: "Project options" })).toBeInTheDocument();

    await user.tab();
    expect(combobox).toHaveAttribute("aria-expanded", "false");
  });

  it("portals the popup, matches the input width, and flips above on collision", () => {
    let movementCheck: FrameRequestCallback | undefined;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      movementCheck = callback;
      return 1;
    });
    const inputRect = {
      bottom: 790,
      height: 32,
      left: 40,
      right: 240,
      top: 758,
      width: 200,
      x: 40,
      y: 758,
      toJSON: () => {},
    } as DOMRect;
    const rectSpy = vi.spyOn(HTMLInputElement.prototype, "getBoundingClientRect");
    rectSpy.mockReturnValue(inputRect);
    const heightSpy = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get");
    heightSpy.mockReturnValue(120);

    const { container } = renderListbox();
    const listbox = screen.getByRole("listbox", { name: "Project options" });
    expect(container.contains(listbox)).toBe(false);
    expect(listbox).toHaveStyle({ left: "40px", top: "634px", width: "200px" });

    rectSpy.mockReturnValue({
      bottom: 132,
      height: 32,
      left: 40,
      right: 240,
      top: 100,
      width: 200,
      x: 40,
      y: 100,
      toJSON: () => {},
    } as DOMRect);
    fireEvent.scroll(container);
    expect(listbox).toHaveStyle({ top: "136px" });

    rectSpy.mockReturnValue({
      bottom: 232,
      height: 32,
      left: 40,
      right: 240,
      top: 200,
      width: 200,
      x: 40,
      y: 200,
      toJSON: () => {},
    } as DOMRect);
    fireEvent.resize(window);
    expect(listbox).toHaveStyle({ top: "236px" });

    rectSpy.mockReturnValue({
      bottom: 232,
      height: 32,
      left: 80,
      right: 280,
      top: 200,
      width: 200,
      x: 80,
      y: 200,
      toJSON: () => {},
    } as DOMRect);
    act(() => movementCheck?.(0));
    expect(listbox).toHaveStyle({ left: "80px" });
  });

  it("layers a portaled popup above an enclosing dialog", async () => {
    const user = userEvent.setup();
    render(
      <dialog open>
        <SearchableListbox
          options={options}
          value={null}
          query=""
          onQueryChange={() => {}}
          onValueChange={() => {}}
          getOptionKey={(value) => value}
          ariaLabel="Project"
          placeholder="Search projects"
        />
      </dialog>,
    );

    await user.click(screen.getByRole("combobox", { name: "Project" }));
    expect(screen.getByRole("listbox", { name: "Project options" })).toHaveStyle({
      zIndex: "calc(var(--z-overlay) + 1)",
    });
  });

  it("shows all choices when the query is only displaying the current selection", () => {
    renderListbox({ value: "alpha", query: "Alpha" });
    expect(screen.getAllByRole("option")).toHaveLength(options.length);
  });

  it("connects the combobox, listbox, and options with accessible state", () => {
    renderListbox({ value: "beta" });
    const combobox = screen.getByRole("combobox", { name: "Project" });
    const listbox = screen.getByRole("listbox", { name: "Project options" });

    expect(combobox).toHaveAttribute("aria-controls", listbox.id);
    expect(combobox).toHaveAttribute("aria-activedescendant");
    expect(screen.getByRole("option", { name: "Beta" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("option", { name: "Disabled" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("filters, bounds results, skips disabled options, and selects with keyboard", async () => {
    const user = userEvent.setup();
    const onQueryChange = vi.fn();
    const onValueChange = vi.fn();
    const { rerender } = renderListbox({ onQueryChange, onValueChange, maxResults: 3 });
    expect(screen.getAllByRole("option")).toHaveLength(3);

    const combobox = screen.getByRole("combobox", { name: "Project" });
    await user.click(combobox);
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onValueChange).toHaveBeenCalledWith("beta");

    rerender(
      <SearchableListbox
        options={options}
        value={null}
        query="second"
        onQueryChange={onQueryChange}
        onValueChange={onValueChange}
        getOptionKey={(value) => value}
        ariaLabel="Project"
        placeholder="Search projects"
      />,
    );
    await user.click(screen.getByRole("combobox", { name: "Project" }));
    expect(screen.getByRole("option", { name: "Beta" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Alpha" })).not.toBeInTheDocument();
  });

  it("selects an option by pointer, closes the popup, and retains input focus", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    renderListbox({ onValueChange });
    const combobox = screen.getByRole("combobox", { name: "Project" });

    await user.click(screen.getByRole("option", { name: "Beta" }));

    expect(onValueChange).toHaveBeenCalledWith("beta");
    expect(combobox).toHaveAttribute("aria-expanded", "false");
    expect(combobox).toHaveFocus();
  });

  it("clamps non-positive maxResults and exposes loading, empty, and error states", () => {
    const { rerender } = renderListbox({ maxResults: 0 });
    expect(screen.getAllByRole("option")).toHaveLength(1);

    rerender(
      <SearchableListbox
        options={[]}
        value={null}
        query=""
        onQueryChange={() => {}}
        onValueChange={() => {}}
        getOptionKey={(value: string) => value}
        ariaLabel="Project"
        placeholder="Search projects"
        loading
        error="Could not load"
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Loading options");
    expect(screen.getByRole("listbox", { name: "Project options" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(screen.getByRole("option")).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("alert")).toHaveTextContent("Could not load");
  });

  it("does not expose or select retained options while loading", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    renderListbox({ loading: true, onValueChange });

    const combobox = screen.getByRole("combobox", { name: "Project" });
    expect(combobox).not.toHaveAttribute("aria-activedescendant");
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it("does not report retained options as active while loading", async () => {
    const user = userEvent.setup();
    const onActiveValueChange = vi.fn();
    renderListbox({ loading: true, onActiveValueChange });

    await user.type(screen.getByRole("combobox", { name: "Project" }), "bet");
    expect(onActiveValueChange).toHaveBeenLastCalledWith(null);
  });

  it("does not swallow Escape or Tab", () => {
    const onKeyDown = vi.fn();
    render(
      <div onKeyDown={onKeyDown}>
        <SearchableListbox
          options={options}
          value={null}
          query=""
          onQueryChange={() => {}}
          onValueChange={() => {}}
          getOptionKey={(value) => value}
          ariaLabel="Project"
          placeholder="Search projects"
        />
      </div>,
    );
    const combobox = screen.getByRole("combobox", { name: "Project" });
    fireEvent.keyDown(combobox, { key: "Escape" });
    fireEvent.keyDown(combobox, { key: "Tab" });
    expect(onKeyDown.mock.calls.map(([event]) => event.key)).toEqual(["Escape", "Tab"]);
  });

  it("closes on Escape but preserves closed input and form keyboard behavior", () => {
    const onValueChange = vi.fn();
    renderListbox({ autoFocus: false, onValueChange });
    const combobox = screen.getByRole("combobox", { name: "Project" });

    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    combobox.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(false);
    expect(onValueChange).not.toHaveBeenCalled();

    const home = new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true });
    combobox.dispatchEvent(home);
    expect(home.defaultPrevented).toBe(false);

    fireEvent.click(combobox);
    expect(combobox).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(combobox, { key: "Escape" });
    expect(combobox).toHaveAttribute("aria-expanded", "false");
  });

  it("does not open when disabled, including when autoFocus is requested", () => {
    renderListbox({ autoFocus: true, disabled: true });
    expect(screen.getByRole("combobox", { name: "Project" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("uses local index-based DOM ids even when opaque keys sanitize alike", () => {
    renderListbox({
      options: [
        { value: "a/b", label: "Slash", searchText: "Slash" },
        { value: "a?b", label: "Question", searchText: "Question" },
      ],
    });
    const ids = screen.getAllByRole("option").map((option) => option.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids.every((id) => document.body.contains(document.getElementById(id)))).toBe(true);
  });

  it("reports only user-originated active values through the typed callback", async () => {
    const user = userEvent.setup();
    const onActiveValueChange = vi.fn();
    renderListbox({ value: "alpha", onActiveValueChange });
    expect(onActiveValueChange).not.toHaveBeenCalled();

    await user.click(screen.getByRole("combobox", { name: "Project" }));
    await user.keyboard("{ArrowDown}");
    expect(onActiveValueChange).toHaveBeenLastCalledWith("beta");
  });

  it("does not commit the automatic first highlight on untouched Enter", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    renderListbox({ onValueChange });

    await user.keyboard("{Enter}");
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it("reconciles external value identity without resetting a keyboard highlight on unrelated renders", async () => {
    const user = userEvent.setup();
    const firstActiveCallback = vi.fn();
    const { rerender } = renderListbox({
      value: "alpha",
      onActiveValueChange: firstActiveCallback,
    });

    rerender(
      <SearchableListbox
        options={options.map((option) => ({ ...option }))}
        value="beta"
        query=""
        onQueryChange={() => {}}
        onValueChange={() => {}}
        onActiveValueChange={firstActiveCallback}
        getOptionKey={(value) => value}
        ariaLabel="Project"
        placeholder="Search projects"
      />,
    );
    expect(screen.getByRole("combobox", { name: "Project" })).toHaveAttribute(
      "aria-activedescendant",
      screen.getByRole("option", { name: "Beta" }).id,
    );

    await user.click(screen.getByRole("combobox", { name: "Project" }));
    await user.keyboard("{ArrowUp}");
    const replacementCallback = vi.fn();
    rerender(
      <SearchableListbox
        options={options.map((option) => ({ ...option }))}
        value="beta"
        query=""
        onQueryChange={() => {}}
        onValueChange={() => {}}
        onActiveValueChange={replacementCallback}
        getOptionKey={(value) => value}
        ariaLabel="Project"
        placeholder="Search projects"
      />,
    );
    expect(screen.getByRole("combobox", { name: "Project" })).toHaveAttribute(
      "aria-activedescendant",
      screen.getByRole("option", { name: "Alpha" }).id,
    );
    expect(replacementCallback).not.toHaveBeenCalled();

    await user.keyboard("{ArrowDown}");
    expect(replacementCallback).toHaveBeenLastCalledWith("beta");
  });

  it("preserves a user-highlighted option by key when options reorder", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    const { rerender } = renderListbox({ onValueChange });
    await user.keyboard("{ArrowDown}");

    rerender(
      <SearchableListbox
        options={[options[2]!, options[0]!, options[1]!]}
        value={null}
        query=""
        onQueryChange={() => {}}
        onValueChange={onValueChange}
        getOptionKey={(value) => value}
        ariaLabel="Project"
        placeholder="Search projects"
        autoFocus
      />,
    );
    expect(screen.getByRole("combobox", { name: "Project" })).toHaveAttribute(
      "aria-activedescendant",
      screen.getByRole("option", { name: "Beta" }).id,
    );
    await user.keyboard("{Enter}");
    expect(onValueChange).toHaveBeenCalledWith("beta");
  });
});
