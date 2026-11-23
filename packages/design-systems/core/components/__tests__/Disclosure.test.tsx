// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postcss, { type Declaration } from "postcss";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { Disclosure } from "../Disclosure";

const theme = readFileSync(join(import.meta.dirname, "../../tokens/theme.css"), "utf8");
const stylesheet = postcss.parse(theme);

function transformFor(selector: string) {
  const rule = stylesheet.nodes.find((node) => node.type === "rule" && node.selector === selector);
  if (rule?.type !== "rule") return undefined;
  return rule.nodes?.find(
    (node): node is Declaration => node.type === "decl" && node.prop === "transform",
  )?.value;
}

afterEach(cleanup);

describe("Disclosure", () => {
  it("uses the shared token-sized caret and native disclosure behavior", () => {
    const { container, rerender } = render(
      <Disclosure summary="Details">
        <p>Disclosure content</p>
      </Disclosure>,
    );

    const details = container.querySelector("details");
    const caret = container.querySelector("[data-disclosure-caret]");
    expect(caret).toHaveClass("size-[var(--size-icon-xs)]", "text-[var(--color-text-muted)]");
    expect(details).toHaveClass("ds-disclosure");
    expect(details).not.toHaveAttribute("open");

    fireEvent.click(screen.getByText("Details"));
    expect(details).toHaveAttribute("open");

    rerender(
      <Disclosure summary="Updated details">
        <p>Disclosure content</p>
      </Disclosure>,
    );
    expect(details).toHaveAttribute("open");
  });

  it("supports controlled state and scopes caret rotation across nesting", () => {
    const onOpenChange = vi.fn();
    const { container, rerender } = render(
      <Disclosure open={false} summary="Outer" onOpenChange={onOpenChange}>
        <Disclosure summary="Inner">
          <p>Nested content</p>
        </Disclosure>
      </Disclosure>,
    );

    const [outer, inner] = container.querySelectorAll("details");
    expect(outer).not.toHaveAttribute("open");
    expect(inner).not.toHaveAttribute("open");
    expect(outer).toHaveAttribute("data-caret-motion", "right-down");
    expect(
      [...container.querySelectorAll("details")].some((detail) =>
        detail.classList.contains("group/disclosure"),
      ),
    ).toBe(false);

    fireEvent.click(screen.getByText("Outer"));
    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(outer).not.toHaveAttribute("open");

    rerender(
      <Disclosure open summary="Outer" onOpenChange={onOpenChange}>
        <Disclosure summary="Inner">
          <p>Nested content</p>
        </Disclosure>
      </Disclosure>,
    );
    expect(outer).toHaveAttribute("open");
  });

  it("can place the shared caret at the end without changing native semantics", () => {
    const { container } = render(
      <Disclosure summary="Details" caretPosition="end" caretSize="md">
        <p>Disclosure content</p>
      </Disclosure>,
    );
    const summary = container.querySelector("summary");
    expect(summary?.lastElementChild).toHaveAttribute("data-disclosure-caret");
    expect(summary?.lastElementChild).toHaveClass("size-[var(--size-icon-md)]");
    fireEvent.click(screen.getByText("Details"));
    expect(container.querySelector("details")).toHaveAttribute("open");
  });

  it("supports a vertical caret that points down when closed and up when open", () => {
    const { container } = render(
      <Disclosure summary="Details" caretMotion="up-down">
        <p>Disclosure content</p>
      </Disclosure>,
    );
    const details = container.querySelector("details");
    expect(details).toHaveAttribute("data-caret-motion", "up-down");
    expect(
      transformFor(
        '.ds-disclosure[data-caret-motion="up-down"] > summary > [data-disclosure-caret]',
      ),
    ).toBe("rotate(0deg)");
    fireEvent.click(screen.getByText("Details"));
    expect(details).toHaveAttribute("open");
    expect(
      transformFor(
        '.ds-disclosure[data-caret-motion="up-down"][open] > summary > [data-disclosure-caret]',
      ),
    ).toBe("rotate(180deg)");
  });
});
