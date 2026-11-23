import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a
      data-link-kind="next"
      data-navigation-adapter="test-double"
      href={typeof href === "string" ? href : undefined}
      {...props}
    >
      {children}
    </a>
  ),
}));

vi.mock("@vercel/microfrontends/next/client", () => ({
  Link: ({ children, href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a
      data-link-kind="microfrontend"
      data-navigation-adapter="test-double"
      href={typeof href === "string" ? href : undefined}
      {...props}
    >
      {children}
    </a>
  ),
}));

import ExampleNextPage from "../page";

describe("Next route-owned example", () => {
  it("renders server-owned content and keeps same-zone navigation app relative", () => {
    render(<ExampleNextPage />);

    expect(
      screen.getByRole("heading", {
        name: "Route ownership, with React Server Components",
      }),
    ).toBeInTheDocument();
    const detailsLink = screen.getByRole("link", { name: "Open the app-owned details route" });
    const viteLink = screen.getByRole("link", { name: "Open the Vite example" });

    expect(detailsLink).toHaveAttribute("href", "/details");
    expect(detailsLink).toHaveAttribute("data-link-kind", "next");
    expect(viteLink).toHaveAttribute("href", "/example-vite");
    expect(viteLink).toHaveAttribute("data-link-kind", "microfrontend");
  });

  it("keeps client behavior in the explicit counter island", async () => {
    const user = userEvent.setup();
    render(<ExampleNextPage />);

    await user.click(screen.getByRole("button", { name: "Increment" }));

    expect(screen.getByText("Client island count:").parentElement).toHaveTextContent(
      "Client island count: 1",
    );
  });
});
