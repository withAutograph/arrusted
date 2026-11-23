// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { ClipboardDocumentList } from "../../icons";
import { DecisionOptionCard } from "../DecisionOptionCard";
import { KpiCard, KpiPill } from "../KpiCard";
import { NativeSelect } from "../Listbox";
import { PageHeader } from "../PageHeader";
import { Tag } from "../Tag";

afterEach(cleanup);

describe("review queue design-system primitives", () => {
  it("uses native grouped radios for decision cards", () => {
    const onSelect = vi.fn();
    render(
      <DecisionOptionCard
        title="Keep Acme"
        name="identity"
        value="keep-acme"
        onSelect={onSelect}
      />,
    );
    const option = screen.getByRole("radio", { name: "Keep Acme" });
    expect(option).not.toBeChecked();
    expect(option).toHaveAttribute("name", "identity");
    fireEvent.click(option);
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it("keeps the comfortable density by default and compacts spacing without changing radio semantics", () => {
    const onSelect = vi.fn();
    const { rerender } = render(
      <DecisionOptionCard
        title="Keep Acme"
        description="Keep this identity separate."
        tag={<span>Recommended</span>}
        name="identity"
        value="keep-acme"
        onSelect={onSelect}
      />,
    );
    const option = screen.getByRole("radio");
    expect(option).not.toBeChecked();
    expect(option.parentElement).toHaveClass("gap-[var(--space-4)]", "p-[var(--space-4)]");

    rerender(
      <DecisionOptionCard
        title="Keep Acme"
        description="Keep this identity separate."
        tag={<span>Recommended</span>}
        name="identity"
        value="keep-acme"
        selected
        density="compact"
        onSelect={onSelect}
      />,
    );
    expect(option).toBeChecked();
    expect(option.parentElement).toHaveClass("gap-[var(--space-3)]", "p-[var(--space-3)]");
    expect(option.parentElement).toHaveClass("has-[:focus-visible]:outline");
    expect(screen.getByText("Recommended")).toBeVisible();
    fireEvent.keyDown(option, { key: "ArrowDown" });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("uses a native keyboard-capable select for the listbox", () => {
    const onValueChange = vi.fn();
    render(
      <NativeSelect
        id="canonical-vendor"
        name="canonical_vendor"
        required
        aria-describedby="canonical-help"
        data-testid="canonical-listbox"
        ariaLabel="Canonical Vendor"
        value="a"
        options={[
          { value: "a", label: "Acme" },
          { value: "b", label: "Acme, Inc." },
        ]}
        onValueChange={onValueChange}
      />,
    );
    const listbox = screen.getByRole("combobox", { name: "Canonical Vendor" });
    expect(listbox).toHaveAttribute("id", "canonical-vendor");
    expect(listbox).toHaveAttribute("name", "canonical_vendor");
    expect(listbox).toBeRequired();
    expect(listbox).toHaveAttribute("aria-describedby", "canonical-help");
    expect(listbox).toHaveAttribute("data-testid", "canonical-listbox");
    fireEvent.change(listbox, {
      target: { value: "b" },
    });
    expect(onValueChange).toHaveBeenCalledWith("b");
  });

  it("renders the review header, KPI context, and categorical tag", () => {
    render(
      <>
        <PageHeader title="Review Queue" subtitle="Resolve open questions" />
        <KpiCard
          icon={ClipboardDocumentList}
          title="Vendor identity"
          value="2"
          valueLabel="questions"
          pills={<KpiPill label="Source evidence" />}
        />
        <Tag label="Ramp" tone="blue" />
      </>,
    );
    expect(screen.getByRole("heading", { name: "Review Queue" })).toBeVisible();
    expect(screen.getByText("2")).toBeVisible();
    expect(screen.getByText("Ramp")).toHaveAttribute("data-tone", "blue");
  });
});
