import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { AgentGrantPage } from "../components/auth/agent-grant";

const context = (picked: { id: string; name: string } | null) => ({
  app: { id: "canvas", resource: "https://example.test/canvas/api/mcp" },
  client: { name: "Test agent", uri: null, verifiedDomain: null },
  organizations: [
    { id: "org-a", name: "Org A" },
    { id: "org-b", name: "Org B" },
  ],
  picked,
});

describe("agent grant consent page", () => {
  const assign = vi.fn();
  beforeEach(() => {
    window.history.replaceState(null, "", "/auth/oauth/consent?client_id=c&sig=s");
    vi.spyOn(window, "location", "get").mockReturnValue({
      ...window.location,
      search: "?client_id=c&sig=s",
      assign,
    } as Location);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    assign.mockReset();
  });

  const respond = (body: unknown) =>
    vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));

  it("returns to the organization step with the same signed request when nothing is picked", async () => {
    respond(context(null));
    render(<AgentGrantPage step="consent" />);
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith("/auth/oauth/organization?client_id=c&sig=s"),
    );
  });

  it("offers Allow for the picked organization", async () => {
    respond(context({ id: "org-a", name: "Org A" }));
    render(<AgentGrantPage step="consent" />);
    expect(await screen.findByText("Org A")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Allow" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(assign).not.toHaveBeenCalled();
  });

  it("names the app and the next step when no organization gives access", async () => {
    respond({
      ...context(null),
      app: { ...context(null).app, id: "comp-canvas" },
      organizations: [],
    });
    render(<AgentGrantPage step="organization" />);
    expect(
      await screen.findByText(
        "None of your organizations gives you access to Comp canvas. Ask your Autograph admin to give you access.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/comp-canvas/u)).toBeNull();
  });
});
