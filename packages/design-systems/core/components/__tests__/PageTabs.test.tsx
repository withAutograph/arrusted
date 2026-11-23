// PageTabs structural + keyboard contract. Indicator math (rAF +
// getBoundingClientRect) is jsdom-mocked; visual proof covers that.

import { useState } from "react";

import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vite-plus/test";

import { PageTabs } from "../PageTabs";

const THREE_OPTIONS = [
  { id: "first", label: "First" },
  { id: "second", label: "Second" },
  { id: "third", label: "Third" },
] as const;

describe("PageTabs", () => {
  it("renders all options as tablist tabs", () => {
    render(<PageTabs value="first" options={[...THREE_OPTIONS]} onChange={() => {}} />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(3);
    expect(tabs[0]).toHaveTextContent("First");
    expect(tabs[1]).toHaveTextContent("Second");
    expect(tabs[2]).toHaveTextContent("Third");
  });

  it("marks the active option with aria-selected and data-active=true", () => {
    render(<PageTabs value="second" options={[...THREE_OPTIONS]} onChange={() => {}} />);
    // getByRole supports the `selected` flag — cleanest idiom for the
    // aria-selected check.
    const active = screen.getByRole("tab", { selected: true });
    expect(active).toHaveTextContent("Second");
    expect(active).toHaveAttribute("data-active", "true");

    const inactives = screen.getAllByRole("tab").filter((tab) => tab !== active);
    for (const tab of inactives) {
      expect(tab).toHaveAttribute("data-active", "false");
      expect(tab).toHaveAttribute("aria-selected", "false");
    }
  });

  it("uses roving tabindex per WAI-ARIA tablist (active=0, inactive=-1)", () => {
    // Without roving tabindex, Tab key cycles through every tab button
    // instead of landing once on the active tab. The arrow-key handlers
    // (covered below) move focus inside the strip.
    render(<PageTabs value="second" options={[...THREE_OPTIONS]} onChange={() => {}} />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs[0]).toHaveAttribute("tabindex", "-1");
    expect(tabs[1]).toHaveAttribute("tabindex", "0");
    expect(tabs[2]).toHaveAttribute("tabindex", "-1");
  });

  it("calls onChange with the id when an inactive option is clicked", () => {
    const onChange = vi.fn();
    render(<PageTabs value="first" options={[...THREE_OPTIONS]} onChange={onChange} />);
    fireEvent.click(screen.getByRole("tab", { name: "Third" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("third");
  });

  it("does not call onChange when the active option is clicked", () => {
    // Load-bearing: the optimistic-pending reconciliation effect assumes
    // self-clicks are no-ops. If someone removes the `!isActive` guard the
    // pendingValue clear can race; this test pins the guard down.
    const onChange = vi.fn();
    render(<PageTabs value="second" options={[...THREE_OPTIONS]} onChange={onChange} />);
    fireEvent.click(screen.getByRole("tab", { name: "Second" }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("returns null when options.length <= 1", () => {
    const { container } = render(
      <PageTabs value="only" options={[{ id: "only", label: "Only" }]} onChange={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.queryByRole("tablist")).toBeNull();
  });

  describe("keyboard navigation (WAI-ARIA tablist pattern)", () => {
    // Wire `value` to local state so the optimistic-pending path inside
    // PageTabs reconciles cleanly — same shape AppShell uses in production.
    function ControlledHarness(props: { initial: string; onChange?: (next: string) => void }) {
      const [value, setValue] = useState(props.initial);
      return (
        <PageTabs
          value={value}
          options={[...THREE_OPTIONS]}
          onChange={(next) => {
            setValue(next);
            props.onChange?.(next);
          }}
        />
      );
    }

    it("Right arrow activates + focuses the next tab", async () => {
      const onChange = vi.fn();
      render(<ControlledHarness initial="first" onChange={onChange} />);
      const first = screen.getByRole("tab", { name: "First" });
      first.focus();
      await userEvent.keyboard("{ArrowRight}");
      expect(onChange).toHaveBeenLastCalledWith("second");
      const second = screen.getByRole("tab", { name: "Second" });
      expect(document.activeElement).toBe(second);
    });

    it("Right arrow wraps from last to first", async () => {
      const onChange = vi.fn();
      render(<ControlledHarness initial="third" onChange={onChange} />);
      const third = screen.getByRole("tab", { name: "Third" });
      third.focus();
      await userEvent.keyboard("{ArrowRight}");
      expect(onChange).toHaveBeenLastCalledWith("first");
      const first = screen.getByRole("tab", { name: "First" });
      expect(document.activeElement).toBe(first);
    });

    it("Left arrow activates + focuses the previous tab", async () => {
      const onChange = vi.fn();
      render(<ControlledHarness initial="second" onChange={onChange} />);
      const second = screen.getByRole("tab", { name: "Second" });
      second.focus();
      await userEvent.keyboard("{ArrowLeft}");
      expect(onChange).toHaveBeenLastCalledWith("first");
      const first = screen.getByRole("tab", { name: "First" });
      expect(document.activeElement).toBe(first);
    });

    it("Left arrow wraps from first to last", async () => {
      const onChange = vi.fn();
      render(<ControlledHarness initial="first" onChange={onChange} />);
      const first = screen.getByRole("tab", { name: "First" });
      first.focus();
      await userEvent.keyboard("{ArrowLeft}");
      expect(onChange).toHaveBeenLastCalledWith("third");
      const third = screen.getByRole("tab", { name: "Third" });
      expect(document.activeElement).toBe(third);
    });

    it("Home activates + focuses the first tab", async () => {
      const onChange = vi.fn();
      render(<ControlledHarness initial="third" onChange={onChange} />);
      const third = screen.getByRole("tab", { name: "Third" });
      third.focus();
      await userEvent.keyboard("{Home}");
      expect(onChange).toHaveBeenLastCalledWith("first");
      const first = screen.getByRole("tab", { name: "First" });
      expect(document.activeElement).toBe(first);
    });

    it("End activates + focuses the last tab", async () => {
      const onChange = vi.fn();
      render(<ControlledHarness initial="first" onChange={onChange} />);
      const first = screen.getByRole("tab", { name: "First" });
      first.focus();
      await userEvent.keyboard("{End}");
      expect(onChange).toHaveBeenLastCalledWith("third");
      const third = screen.getByRole("tab", { name: "Third" });
      expect(document.activeElement).toBe(third);
    });
  });
});
