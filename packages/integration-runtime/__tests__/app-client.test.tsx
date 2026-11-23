// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { AppIntegrationClient } from "../app-client";

const state = vi.hoisted(() => ({ refresh: vi.fn(), outcomes: [] as unknown[] }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: state.refresh }) }));
vi.mock("@autograph/components", () => ({
  Button: ({ children, intent: _intent, ...props }: { children: ReactNode; intent?: string }) => (
    <button {...props}>{children}</button>
  ),
}));
vi.mock("@modules/integrations", () => ({
  IntegrationActionProvider: ({
    children,
    onAction,
  }: {
    children: ReactNode;
    onAction: (input: { kind: string; providerId: string; accountId?: string }) => Promise<unknown>;
  }) => (
    <>
      <button
        onClick={() => {
          void onAction({ kind: "connect", providerId: "quickbooks" })
            .then((result) => state.outcomes.push(result))
            .catch((error: unknown) => state.outcomes.push(error));
        }}
      >
        Connect account
      </button>
      <button
        onClick={() => {
          void onAction({ kind: "reconnect", providerId: "quickbooks", accountId: "conn" })
            .then((result) => state.outcomes.push(result))
            .catch((error: unknown) => state.outcomes.push(error));
        }}
      >
        Reconnect account
      </button>
      <button
        onClick={() => {
          void onAction({ kind: "activate", providerId: "quickbooks", accountId: "conn" })
            .then((result) => state.outcomes.push(result))
            .catch((error: unknown) => state.outcomes.push(error));
        }}
      >
        Activate account
      </button>
      <button
        onClick={() => {
          void onAction({ kind: "configure", providerId: "quickbooks" })
            .then((result) => state.outcomes.push(result))
            .catch((error: unknown) => state.outcomes.push(error));
        }}
      >
        Configure account
      </button>
      {children}
    </>
  ),
}));

describe("shared inline server-owned connection setup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.outcomes.length = 0;
  });
  afterEach(cleanup);
  it("passes the selected account to reconnect preparation and confirmation", async () => {
    const prepareReconnect = vi.fn(async () => ({
      setupId: "reconnect-proof",
      authorizationUrl: "https://provider.example/authorize",
    }));
    const completeReconnect = vi.fn(async () => ({ status: "connected" as const }));
    const prepareConnection = vi.fn(async () => ({
      setupId: "unexpected",
      authorizationUrl: "https://provider.example",
    }));
    render(
      <AppIntegrationClient
        prepareConnection={prepareConnection}
        completeConnection={async () => ({ status: "pending" })}
        prepareReconnect={prepareReconnect}
        completeReconnect={completeReconnect}
      >
        <div />
      </AppIntegrationClient>,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Reconnect account" }));
    });
    expect(prepareReconnect).toHaveBeenCalledWith("quickbooks", "conn");
    expect(prepareConnection).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Check connection" }));
    });
    expect(completeReconnect).toHaveBeenCalledWith("quickbooks", "conn", "reconnect-proof");
  });
  it("sends only the server-issued grant to the activation route", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 204 }),
    );
    vi.stubGlobal("fetch", fetcher);
    try {
      render(
        <AppIntegrationClient
          prepareConnection={async () => {
            throw new Error("unused");
          }}
          completeConnection={async () => ({ status: "pending" })}
          prepareActivation={async () => ({
            status: "ready",
            grant: "signed",
            path: "/spend/api/integrations/quickbooks/activate",
          })}
        >
          <div>App</div>
        </AppIntegrationClient>,
      );
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Activate account" }));
      });
      expect(fetcher).toHaveBeenCalledOnce();
      expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
        method: "POST",
        body: JSON.stringify({ grant: "signed" }),
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("opens only the authorized URL, waits for server confirmation, and refreshes an embedded host", async () => {
    const prepareConnection = vi.fn(async () => ({
      setupId: "signed-setup",
      authorizationUrl: "https://provider.example/authorize",
    }));
    let connected = false;
    const completeConnection = vi.fn(async () =>
      connected ? { status: "connected" as const } : { status: "pending" as const },
    );
    render(
      <AppIntegrationClient
        prepareConnection={prepareConnection}
        completeConnection={completeConnection}
      >
        <div>Embedded app</div>
      </AppIntegrationClient>,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Connect account" }));
    });
    const link = screen.getByRole("link", { name: "Open provider sign-in" });
    expect(link.getAttribute("href")).toBe("https://provider.example/authorize");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(state.outcomes).toHaveLength(0);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Check connection" }));
    });
    expect(completeConnection).toHaveBeenCalledWith("quickbooks", "signed-setup");
    expect(screen.getByRole("status").textContent).toContain("not confirmed");
    expect(state.outcomes).toHaveLength(0);
    connected = true;
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Check connection" }));
    });
    expect(state.refresh).toHaveBeenCalled();
    expect(screen.queryByRole("link", { name: "Open provider sign-in" })).toBeNull();
  });
  it("keeps confirmed connections complete when refreshing the view fails", async () => {
    const completeConnection = vi.fn(async () => ({ status: "connected" as const }));
    render(
      <AppIntegrationClient
        prepareConnection={async () => ({
          setupId: "setup",
          authorizationUrl: "https://provider.example/auth",
        })}
        completeConnection={completeConnection}
        onRefresh={async () => {
          throw new Error("private refresh failure");
        }}
      >
        <div />
      </AppIntegrationClient>,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Connect account" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Check connection" }));
    });
    expect(completeConnection).toHaveBeenCalledTimes(1);
    expect(state.outcomes).toEqual([undefined]);
    expect(screen.queryByRole("button", { name: "Check connection" })).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("connection is confirmed");
    expect(screen.getByRole("status").textContent).not.toContain("private refresh failure");
  });
  it("cancels without registering and refreshes after an ordinary successful action", async () => {
    const completeConnection = vi.fn(async () => ({ status: "connected" as const }));
    const onAction = vi.fn(async () => {});
    const view = render(
      <AppIntegrationClient
        prepareConnection={async () => ({
          setupId: "setup",
          authorizationUrl: "https://provider.example/auth",
        })}
        completeConnection={completeConnection}
        onAction={onAction}
      >
        <div />
      </AppIntegrationClient>,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Connect account" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    });
    expect(completeConnection).not.toHaveBeenCalled();
    expect(state.outcomes.at(-1)).toEqual({ status: "cancelled" });
    const refreshes = state.refresh.mock.calls.length;
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Configure account" }));
    });
    expect(onAction).toHaveBeenCalledWith({ kind: "configure", providerId: "quickbooks" });
    expect(state.refresh.mock.calls.length).toBe(refreshes + 1);
    view.unmount();
  });
});
