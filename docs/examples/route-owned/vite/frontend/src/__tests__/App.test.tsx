import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { App } from "../App";
import { nextExamplePath, normalizeMountPath, routeFromPathname, routePath } from "../router";

const adapterBase = import.meta.env.BASE_URL;
const mountPath = normalizeMountPath(adapterBase);

describe("Vite route-owned example", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", mountPath);
  });

  it("renders independently at its directory-derived mount", () => {
    render(<App />);

    expect(
      screen.getByRole("heading", {
        name: "A client app can own the route, too",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Open the client-routed details view" }),
    ).toHaveAttribute("href", routePath("details", adapterBase));
    expect(screen.getByRole("link", { name: "Open the Next example" })).toHaveAttribute(
      "href",
      nextExamplePath,
    );
    expect(screen.getByRole("link", { name: "Open the Next example" })).toHaveAttribute(
      "data-cross-application",
      "document",
    );
  });

  it("owns same-zone client navigation", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("link", { name: "Open the client-routed details view" }));

    expect(window.location.pathname).toBe(routePath("details", adapterBase));
    expect(
      screen.getByRole("heading", {
        name: "The shell did not render this view",
      }),
    ).toBeInTheDocument();
  });

  it("normalizes an adapter-supplied base after the app is copied or renamed", () => {
    const renamedBase = "/reference/renamed-zone//";

    expect(normalizeMountPath(renamedBase)).toBe("/reference/renamed-zone");
    expect(routePath("home", renamedBase)).toBe("/reference/renamed-zone");
    expect(routePath("details", renamedBase)).toBe("/reference/renamed-zone/details");
    expect(routeFromPathname("/reference/renamed-zone/details/", renamedBase)).toBe("details");
  });
});
