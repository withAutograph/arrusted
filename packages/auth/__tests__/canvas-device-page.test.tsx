import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { CanvasDevicePage } from "../components/auth/canvas-device";

describe("canvas device sign-in page", () => {
  const assign = vi.fn();
  beforeEach(() => {
    vi.spyOn(window, "location", "get").mockReturnValue({
      ...window.location,
      pathname: "/auth/device",
      search: "?user_code=ABCD2345",
      assign,
    } as Location);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    assign.mockReset();
  });

  it("sends a signed-out person to sign in and back to this code", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ message: "Unauthorized" }), { status: 401 }),
    );
    render(<CanvasDevicePage />);
    await waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
    const target = new URL(String(assign.mock.calls[0]![0]), "https://apps.test");
    expect(target.pathname).toBe("/auth/sign-in");
    expect(target.searchParams.get("redirectTo")).toBe("/auth/device?user_code=ABCD2345");
  });

  it("picks the organization, then approves the code, with the consent copy", async () => {
    const calls: { path: string; body: unknown }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const path = String(input);
      calls.push({ path, body: JSON.parse(String(init?.body)) });
      const body = path.endsWith("/canvas-grant/context")
        ? {
            app: { id: "comp-canvas", resource: "https://apps.test/comp-canvas/api/canvas" },
            organizations: [
              { id: "org-a", name: "Org A" },
              { id: "org-b", name: "Org B" },
            ],
            picked: null,
          }
        : { ok: true };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    render(<CanvasDevicePage />);
    expect(
      await screen.findByText(
        "Let Comp canvas in this chat act as you: edit, Save, review and, if you approve drafts, approve and publish.",
      ),
    ).toBeTruthy();
    const approve = screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("Org B"));
    fireEvent.click(approve);
    expect(await screen.findByText("You're signed in")).toBeTruthy();
    expect(calls.map((call) => call.path)).toEqual([
      "/api/auth/canvas-grant/context",
      "/api/auth/canvas-grant/organization",
      "/api/auth/device/approve",
    ]);
    expect(calls[1]!.body).toEqual({ user_code: "ABCD2345", organizationId: "org-b" });
    expect(calls[2]!.body).toEqual({ userCode: "ABCD2345" });
  });

  it("names the app and the next step when no organization gives access", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          app: { id: "comp-canvas", resource: "https://apps.test/comp-canvas/api/canvas" },
          organizations: [],
          picked: null,
        }),
        { status: 200 },
      ),
    );
    render(<CanvasDevicePage />);
    expect(
      await screen.findByText(
        "None of your organizations gives you access to Comp canvas. Ask your Autograph admin to give you access.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });
});
