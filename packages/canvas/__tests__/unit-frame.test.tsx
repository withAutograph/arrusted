// A unit's header: the title keeps priority and Remove stays on its row; the
// controls sit beside the title while they fit and wrap below it otherwise.
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";

import { UnitFrame } from "../unit-frame";

describe("unit header", () => {
  it("puts the title first, the controls in a wrapping group and Remove at the end of the title row", () => {
    render(
      <UnitFrame
        controls={<button type="button">All Job Family</button>}
        title="Salary at 100% zone vs range"
        unitId="u1"
        onRemove={vi.fn()}
      >
        <p>Chart</p>
      </UnitFrame>,
    );
    const header = screen
      .getByRole("heading", { name: "Salary at 100% zone vs range" })
      .parentElement!.closest("header")!;
    const [main, remove] = [...header.children];
    // The title and controls share one wrapping area; Remove is outside it, on the right.
    expect(main).toHaveAttribute("data-unit-header-main");
    expect(main).toHaveClass("flex-wrap", "flex-1");
    expect(remove).toHaveAttribute("data-unit-remove");
    expect(remove).toContainElement(
      screen.getByRole("button", { name: "Remove Salary at 100% zone vs range" }),
    );
    expect(header.lastElementChild).toBe(remove);
    // The title row comes first and does not shrink: the controls wrap below instead.
    const [titleRow, controls] = [...main!.children];
    expect(titleRow).toHaveAttribute("data-unit-title-row");
    expect(titleRow).toHaveClass("shrink-0", "max-w-full");
    expect(titleRow).toContainElement(screen.getByRole("heading"));
    expect(controls).toHaveAttribute("data-unit-controls");
    expect(controls).toHaveClass("flex-wrap");
    expect(controls).toContainElement(screen.getByRole("button", { name: "All Job Family" }));
    expect(controls).not.toContainElement(
      screen.getByRole("button", { name: "Remove Salary at 100% zone vs range" }),
    );
  });

  it("shows no controls group and no Remove when there are none", () => {
    render(
      <UnitFrame title="Employees" unitId="u2">
        <p>Table</p>
      </UnitFrame>,
    );
    const header = screen.getByRole("heading", { name: "Employees" }).closest("header")!;
    expect(header.querySelector("[data-unit-controls]")).toBeNull();
    expect(header.querySelector("[data-unit-remove]")).toBeNull();
  });
});
