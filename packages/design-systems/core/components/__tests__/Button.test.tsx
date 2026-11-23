// @vitest-environment jsdom

// The `slim` size exists so a card can carry a real action without the button
// out-shouting the number it sits next to, and `buttonClassName` exists so a
// navigating action can be an anchor and still look like that button.

import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { Button, buttonClassName } from "../Button";

afterEach(cleanup);

describe("Button", () => {
  it("gives slim the short control height but keeps body-sized text", () => {
    render(
      <Button intent="primary" size="slim">
        Review
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Review" });
    expect(button.className).toContain("h-[var(--size-control-sm)]");
    // Not --text-control-sm: a slim button is shorter, not quieter.
    expect(button.className).toContain("text-[length:var(--text-control-md)]");
  });

  it("hands an anchor the exact classes the button would have worn", () => {
    render(
      <Button intent="primary" size="slim">
        Review
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Review" });
    expect(buttonClassName({ intent: "primary", size: "slim" })).toBe(button.className);
  });

  it("offers an opt-in strong primary appearance without changing primary", () => {
    render(
      <>
        <Button intent="primary">Primary</Button>
        <Button intent="primary-strong">Strong primary</Button>
      </>,
    );

    expect(screen.getByRole("button", { name: "Primary" })).toHaveClass(
      "bg-[var(--color-action-primary)]",
      "transition-colors",
      "hover:bg-[var(--color-action-primary-hover)]",
    );
    expect(screen.getByRole("button", { name: "Strong primary" })).toHaveClass(
      "bg-[var(--color-action-primary-ink)]",
      "text-[var(--color-text-inverse)]",
      "transition-[color,background-color,border-color,box-shadow]",
      "hover:shadow-[var(--shadow-raised)]",
    );
  });

  it("marks a disabled button so the link form can be styled to match", () => {
    expect(buttonClassName({ disabled: true })).toContain("cursor-not-allowed");
    expect(buttonClassName({})).not.toContain("cursor-not-allowed");
  });
});
