// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it } from "vite-plus/test";

import { Tag } from "../Tag";

afterEach(cleanup);

it("preserves compact default typography and gray tone", () => {
  const { rerender } = render(<Tag label="Reference" />);
  const originalClasses = screen.getByText("Reference").className;
  expect(screen.getByText("Reference")).toHaveClass(
    "text-[length:var(--text-micro)]",
    "px-[var(--space-2)]",
    "py-[var(--space-0-5)]",
    "bg-[var(--color-bg-muted)]",
    "text-[var(--color-text-secondary)]",
  );
  rerender(<Tag label="Reference" size="sm" />);
  expect(screen.getByText("Reference").className).toBe(originalClasses);
});

it.each([
  ["red", "danger"],
  ["amber", "warning"],
] as const)("uses body typography with existing %s status colors", (tone, token) => {
  render(<Tag label="Needs attention" size="md" tone={tone} />);
  expect(screen.getByText("Needs attention")).toHaveClass(
    "text-[length:var(--text-body)]",
    "leading-[var(--leading-body)]",
    "px-[var(--space-2-5)]",
    "py-[var(--space-1)]",
    `bg-[var(--color-status-${token}-bg)]`,
    `text-[var(--color-status-${token}-ink)]`,
  );
});
