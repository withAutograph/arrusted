import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vite-plus/test";
import OrganizationPage from "../../app/auth/oauth/organization/page";
import ConsentPage from "../../app/auth/oauth/consent/page";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

test("app /auth/oauth/organization page auto-picks the single org via /agent-grant/* and /oauth2/continue without ever calling /organization/*", async () => {
  window.history.replaceState(
    null,
    "",
    "/auth/oauth/organization?client_id=test-agent&sig=signed-query",
  );
  const calledPaths: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    calledPaths.push(url);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    if (url === "/api/auth/agent-grant/context") {
      expect(body.oauth_query).toBe("client_id=test-agent&sig=signed-query");
      return Response.json({
        app: { id: "starter", resource: "http://127.0.0.1:4555/starter/api/mcp" },
        client: { name: "Test Agent", uri: null, verifiedDomain: null },
        organizations: [{ id: "starter", name: "Starter" }],
        picked: null,
      });
    }
    if (url === "/api/auth/agent-grant/organization") {
      expect(body).toEqual({
        oauth_query: "client_id=test-agent&sig=signed-query",
        organizationId: "starter",
      });
      return Response.json({ ok: true });
    }
    if (url === "/api/auth/oauth2/continue") {
      expect(body).toEqual({
        oauth_query: "client_id=test-agent&sig=signed-query",
        postLogin: true,
      });
      return Response.json({ url: "#next-consent" });
    }
    throw new Error(`Unexpected fetch path: ${url}`);
  });

  render(<OrganizationPage />);

  await waitFor(() => expect(window.location.hash).toBe("#next-consent"));
  expect(calledPaths).toEqual([
    "/api/auth/agent-grant/context",
    "/api/auth/agent-grant/organization",
    "/api/auth/oauth2/continue",
  ]);
  expect(calledPaths.some((p) => p.includes("/organization/"))).toBe(false);
});

test("app /auth/oauth/consent page displays the picked org and posts Allow to /oauth2/consent without ever calling /organization/*", async () => {
  window.history.replaceState(null, "", "/auth/oauth/consent?client_id=test-agent&sig=signed-2");
  const calledPaths: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    calledPaths.push(url);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    if (url === "/api/auth/agent-grant/context") {
      return Response.json({
        app: { id: "starter", resource: "http://127.0.0.1:4555/starter/api/mcp" },
        client: { name: "Test Agent", uri: null, verifiedDomain: null },
        organizations: [{ id: "starter", name: "Starter" }],
        picked: { id: "starter", name: "Starter" },
      });
    }
    if (url === "/api/auth/oauth2/consent") {
      expect(body).toEqual({ accept: true, oauth_query: "client_id=test-agent&sig=signed-2" });
      return Response.json({ url: "#next-callback" });
    }
    throw new Error(`Unexpected fetch path: ${url}`);
  });

  render(<ConsentPage />);

  await waitFor(() => expect(screen.getByText("Allow Test Agent?")).toBeTruthy());
  expect(screen.getByText("Starter")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Allow" }));
  await waitFor(() => expect(window.location.hash).toBe("#next-callback"));
  expect(calledPaths).toEqual(["/api/auth/agent-grant/context", "/api/auth/oauth2/consent"]);
  expect(calledPaths.some((p) => p.includes("/organization/"))).toBe(false);
});
