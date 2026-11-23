import { describe, expect, it, vi } from "vite-plus/test";

import { createAuthenticatedCsvWorkspaceClient } from "../client";
import { createCsvWorkspaceRequestHandler } from "../server";

describe("authenticated CSV workspace client", () => {
  it("composes with the default public server route without custom path wiring", async () => {
    const context = { scope: { appId: "customer-app", customerId: "customer" } };
    const handler = createCsvWorkspaceRequestHandler({ inspect: async () => context } as never);
    const client = createAuthenticatedCsvWorkspaceClient({
      fetch: (input, init) =>
        handler(new Request(new URL(String(input), "https://customer.test"), init)),
    });
    await expect(client.loadWorkspace()).resolves.toEqual(context);
  });
  it("rejects an oversized UTF-8 Save before sending and reports that it did not apply", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = createAuthenticatedCsvWorkspaceClient({ fetch });
    await expect(client.save({ note: "é".repeat(2 * 1024 * 1024) } as never)).rejects.toMatchObject(
      { status: 413, outcome: "not_applied" },
    );
    expect(fetch).not.toHaveBeenCalled();
  });
  it("routes an exact Save retry using its original date after the page date changes", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("{}"));
    const client = createAuthenticatedCsvWorkspaceClient({
      asOf: "2026-09-08",
      baseUrl: "/vendor/api/csv-workspace",
      fetch,
    });
    await client.save({ recoveryContext: { asOf: "2026-09-06" } } as never);
    expect(fetch).toHaveBeenCalledWith(
      "/vendor/api/csv-workspace/save?as_of=2026-09-06",
      expect.objectContaining({ method: "POST" }),
    );
  });
  it("provides bearer auth and preserves explicit Save outcome evidence", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: "Rejected", outcome: "not_applied" }), {
        status: 422,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = createAuthenticatedCsvWorkspaceClient({
      accessToken: () => "scoped-token",
      asOf: "2026-09-07",
      baseUrl: "https://workspace.example/",
      fetch,
    });

    await expect(client.save({} as never)).rejects.toMatchObject({
      status: 422,
      outcome: "not_applied",
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://workspace.example/save?as_of=2026-09-07",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer scoped-token" }),
      }),
    );
  });

  it("uses the host cookie session and appends the selected date to every request", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(
      async () =>
        new Response(JSON.stringify({ scope: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const client = createAuthenticatedCsvWorkspaceClient({
      asOf: () => "2026-05-24",
      baseUrl: "/hc/api/csv-workspace",
      fetch,
    });

    await client.loadWorkspace();
    await client.getJson("/api/schema?revision=active");

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "/hc/api/csv-workspace/workspace?as_of=2026-05-24",
      expect.objectContaining({ credentials: "same-origin", headers: {} }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "/hc/api/csv-workspace/schema?revision=active&as_of=2026-05-24",
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });
});
