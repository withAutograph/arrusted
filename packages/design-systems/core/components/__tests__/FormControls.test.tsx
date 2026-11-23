// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { Select } from "../FormControls";

afterEach(cleanup);

describe("Select", () => {
  it("uses the shared inset caret instead of native browser chrome", () => {
    const { container } = render(
      <Select
        aria-label="Category"
        value="group-a"
        options={[{ value: "group-a", label: "Group A" }]}
      />,
    );

    expect(screen.getByRole("combobox", { name: "Category" })).toHaveClass(
      "appearance-none",
      "pr-[var(--space-8)]",
    );
    expect(container.querySelector("svg")).toHaveClass(
      "right-[var(--space-3)]",
      "size-[var(--size-icon-sm)]",
      "text-[var(--color-text-muted)]",
    );
  });

  it("preserves the intrinsic-width contract for compact toolbar selects", () => {
    const { container } = render(
      <Select
        aria-label="Category"
        className="w-auto"
        size="sm"
        value="all"
        options={[{ value: "all", label: "All" }]}
      />,
    );

    expect(container.firstElementChild).toHaveClass("inline-block", "w-auto");
    expect(screen.getByRole("combobox", { name: "Category" })).toHaveClass("w-auto");
  });

  it("preserves max-width constraints on the select root wrapper", () => {
    const { container } = render(
      <Select
        aria-label="Status"
        className="max-w-[var(--size-editor-value-select-min)]"
        value="all"
        options={[{ value: "all", label: "All statuses" }]}
      />,
    );

    expect(container.firstElementChild).toHaveClass(
      "inline-block",
      "max-w-[var(--size-editor-value-select-min)]",
    );
    expect(screen.getByRole("combobox", { name: "Status" })).toHaveClass(
      "max-w-[var(--size-editor-value-select-min)]",
    );
  });
});
