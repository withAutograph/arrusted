import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";

import { Breadcrumbs } from "../Breadcrumbs";

const renderLink = ({ label, href }: { label: string; href: string }) => <a href={href}>{label}</a>;

describe("Breadcrumbs", () => {
  it("links every crumb except the one you are standing on", () => {
    render(
      <Breadcrumbs
        entries={[{ label: "Review queue", href: "/review" }, { label: "Current item" }]}
        renderLink={renderLink}
      />,
    );
    expect(screen.getByRole("link", { name: "Review queue" })).toHaveAttribute("href", "/review");
    // A link to where you already are is a promise the app cannot keep.
    expect(screen.queryByRole("link", { name: "Current item" })).toBeNull();
  });

  it("marks the current page for assistive technology", () => {
    render(
      <Breadcrumbs
        entries={[{ label: "Review queue", href: "/review" }, { label: "Current item" }]}
        renderLink={renderLink}
      />,
    );
    expect(screen.getByText("Current item")).toHaveAttribute("aria-current", "page");
  });

  it("does not link a crumb that was given no destination", () => {
    render(
      <Breadcrumbs
        entries={[{ label: "Archived" }, { label: "Review queue", href: "/x" }, { label: "Here" }]}
        renderLink={renderLink}
      />,
    );
    expect(screen.queryByRole("link", { name: "Archived" })).toBeNull();
    expect(screen.getByRole("link", { name: "Review queue" })).toBeTruthy();
  });

  it("renders nothing when there is nowhere to go back to", () => {
    // One crumb is just the page title, which the page header already states.
    const { container } = render(
      <Breadcrumbs entries={[{ label: "Review queue" }]} renderLink={renderLink} />,
    );
    expect(container.querySelector("[data-breadcrumbs]")).toBeNull();
  });

  it("hides the separators from the accessible name", () => {
    render(
      <Breadcrumbs
        entries={[{ label: "Review queue", href: "/review" }, { label: "Current item" }]}
        renderLink={renderLink}
      />,
    );
    const nav = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(nav.querySelectorAll('[aria-hidden="true"]')).toHaveLength(1);
  });
});
