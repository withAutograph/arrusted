import { render, screen, fireEvent, within, waitFor, act } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { IntegrationsSurface } from "../IntegrationsSurface";
import { IntegrationActionProvider } from "../IntegrationActionProvider";
import type { IntegrationAccount, IntegrationsSurfaceProps } from "../types";

const account: IntegrationAccount = {
  id: "account-1",
  providerId: "ledger",
  label: "North company",
  status: { label: "Connected", tone: "success" },
  activation: { label: "Active", tone: "success" },
  health: {
    label: "Healthy",
    tone: "success",
    message: "Last sync succeeded",
    details: [{ label: "Rows", value: "12" }],
  },
  actions: [
    { kind: "reconnect", availability: "available" },
    { kind: "activate", availability: "unavailable", reason: "Already active in this app." },
    {
      kind: "configure",
      availability: "available",
      fields: [
        {
          id: "period",
          label: "Sync period",
          value: "month",
          options: [
            { value: "month", label: "This month" },
            { value: "year", label: "This year" },
          ],
        },
      ],
    },
    {
      kind: "disable",
      availability: "available",
      impact: { summary: "Stops new imports here.", affectedApps: ["Planning"] },
    },
    {
      kind: "disconnect",
      availability: "available",
      impact: { summary: "Two apps lose access.", affectedApps: ["Planning", "Review"] },
    },
  ],
};
const data: IntegrationsSurfaceProps = {
  providers: [
    {
      id: "ledger",
      name: "Ledger",
      description: "Accounting records",
      status: { label: "Available", tone: "neutral" },
      connect: { kind: "connect", availability: "available" },
    },
    {
      id: "crm",
      name: "CRM",
      description: "Customer records",
      status: { label: "Coming soon", tone: "neutral" },
      connect: {
        kind: "connect",
        availability: "unavailable",
        reason: "Not available for this organization.",
      },
    },
  ],
  accounts: [account, { ...account, id: "account-2", label: "South company", actions: [] }],
  activity: [
    {
      id: "event-1",
      providerId: "ledger",
      title: "Import completed",
      accountLabel: "North company",
      occurredAt: "Today at 10:30",
      detail: "12 rows imported",
    },
  ],
};

function firstAccount() {
  return screen.getByRole("article", { name: "Ledger: North company" });
}

describe("IntegrationsSurface", () => {
  it("bridges client actions around server content and treats cancellation as ordinary close", async () => {
    const onAction = vi.fn().mockResolvedValue({ status: "cancelled" });
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    render(
      <IntegrationActionProvider onAction={onAction} onRefresh={onRefresh}>
        <IntegrationsSurface {...data} />
      </IntegrationActionProvider>,
    );
    fireEvent.click(within(firstAccount()).getByRole("button", { name: "Reconnect" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(screen.queryByRole("form")).not.toBeInTheDocument());
    expect(onAction).toHaveBeenCalledWith({
      kind: "reconnect",
      providerId: "ledger",
      accountId: "account-1",
    });
    expect(screen.queryByText("Action completed.")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh integrations" }));
    await waitFor(() => expect(onRefresh).toHaveBeenCalledOnce());
  });
  it("server-renders catalog, every account, health and activity without fetching or SDK setup", () => {
    const onAction = vi.fn();
    const html = renderToString(<IntegrationsSurface {...data} onAction={onAction} />);
    for (const text of [
      "Ledger",
      "CRM",
      "North company",
      "South company",
      "Healthy",
      "Last sync succeeded",
      "Import completed",
      "12 rows imported",
    ])
      expect(html).toContain(text);
    expect(onAction).not.toHaveBeenCalled();
    expect(html).not.toContain("ampersand-ui");
  });

  it.each([{ providerIds: undefined }, { providerIds: ["ledger"] }])(
    "preserves independent accounts, health and activity when catalog discovery fails: %j",
    ({ providerIds }) => {
      const html = renderToString(
        <IntegrationsSurface
          {...data}
          providers={[]}
          providerIds={providerIds}
          state={{ catalog: { status: "error", message: "Catalog unavailable" } }}
        />,
      );
      expect(html).toContain("Catalog unavailable");
      expect(html).toContain('aria-label="ledger: North company"');
      expect(html).toContain("South company");
      expect(html).toContain("Last sync succeeded");
      expect(html).toContain("Import completed");
      expect(html).not.toContain("undefined:");
      expect(html).not.toContain("No recent integration activity");
      expect(html).not.toContain("No connected accounts yet");
    },
  );
  it("keeps explicit provider filtering on independent data without granting catalog actions", () => {
    render(
      <IntegrationsSurface
        {...data}
        providers={[]}
        providerIds={["crm"]}
        state={{ catalog: { status: "error", message: "Catalog unavailable" } }}
      />,
    );
    expect(screen.queryByText("North company")).not.toBeInTheDocument();
    expect(screen.queryByText("Import completed")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect account" })).not.toBeInTheDocument();
  });

  it("uses explicit capabilities and filtering cannot grant unavailable actions", () => {
    const onAction = vi.fn();
    render(
      <IntegrationsSurface
        {...data}
        providerIds={["crm", "not-a-provider", "crm"]}
        onAction={onAction}
      />,
    );
    expect(screen.queryByRole("article", { name: "Ledger" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("article")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Connect account" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Connect account" }));
    expect(screen.queryByRole("form")).not.toBeInTheDocument();
    expect(onAction).not.toHaveBeenCalled();
  });

  it("searches only the authorized catalog and reports no matches", () => {
    render(<IntegrationsSurface {...data} />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "customer" } });
    expect(screen.queryByRole("article", { name: "Ledger" })).not.toBeInTheDocument();
    expect(screen.getByRole("article", { name: "CRM" })).toBeVisible();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "unknown" } });
    expect(screen.getByRole("status")).toHaveTextContent("No integrations match");
  });

  it("reviews organization-wide impact before disconnecting the selected account", async () => {
    const onAction = vi.fn().mockResolvedValue(undefined);
    render(<IntegrationsSurface {...data} onAction={onAction} />);
    fireEvent.click(
      within(firstAccount()).getByRole("button", { name: "Disconnect from organization" }),
    );
    expect(onAction).not.toHaveBeenCalled();
    const review = screen.getByRole("form", { name: "Disconnect from organization" });
    expect(within(review).getByText("Two apps lose access.")).toBeVisible();
    expect(within(review).getByText("Planning")).toBeVisible();
    expect(within(review).getByText("Review")).toBeVisible();
    fireEvent.click(
      within(review).getByRole("button", { name: "Confirm disconnect from organization" }),
    );
    await waitFor(() =>
      expect(onAction).toHaveBeenCalledWith({
        kind: "disconnect",
        providerId: "ledger",
        accountId: "account-1",
      }),
    );
  });

  it("distinguishes app-only disable and supports cancel without effects", () => {
    const onAction = vi.fn();
    render(<IntegrationsSurface {...data} onAction={onAction} />);
    fireEvent.click(within(firstAccount()).getByRole("button", { name: "Disable for this app" }));
    const review = screen.getByRole("form", { name: "Disable for this app" });
    expect(review).toHaveTextContent("organization connection remains available");
    expect(within(review).queryByText("Review")).not.toBeInTheDocument();
    fireEvent.click(within(review).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("form")).not.toBeInTheDocument();
    expect(onAction).not.toHaveBeenCalled();
  });

  it.each(["disable", "disconnect"] as const)(
    "echoes the exact reviewed impact token for %s",
    async (kind) => {
      const onAction = vi.fn().mockResolvedValue(undefined);
      const reviewToken = "opaque-reviewed-impact:revision-3";
      render(
        <IntegrationsSurface
          {...data}
          accounts={[
            {
              ...account,
              actions: [
                {
                  kind,
                  availability: "available",
                  impact: { summary: "Reviewed scope", affectedApps: ["Planning"], reviewToken },
                },
              ],
            },
          ]}
          onAction={onAction}
        />,
      );
      fireEvent.click(
        within(firstAccount()).getByRole("button", {
          name: kind === "disable" ? "Disable for this app" : "Disconnect from organization",
        }),
      );
      expect(onAction).not.toHaveBeenCalled();
      fireEvent.click(
        screen.getByRole("button", {
          name:
            kind === "disable"
              ? "Confirm disable for this app"
              : "Confirm disconnect from organization",
        }),
      );
      await waitFor(() =>
        expect(onAction).toHaveBeenCalledWith({
          kind,
          providerId: "ledger",
          accountId: "account-1",
          reviewToken,
        }),
      );
    },
  );

  it("submits inline public configuration choices for the correct account", async () => {
    const onAction = vi.fn().mockResolvedValue(undefined);
    render(<IntegrationsSurface {...data} onAction={onAction} />);
    fireEvent.click(within(firstAccount()).getByRole("button", { name: "Configure" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Sync period" }), {
      target: { value: "year" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() =>
      expect(onAction).toHaveBeenCalledWith({
        kind: "configure",
        providerId: "ledger",
        accountId: "account-1",
        values: { period: "year" },
      }),
    );
  });

  it.each(["connect", "activate"] as const)(
    "keeps %s explicit and reports successful completion",
    async (kind) => {
      const onAction = vi.fn().mockResolvedValue(undefined);
      render(
        <IntegrationsSurface
          {...data}
          accounts={[{ ...account, actions: [{ kind: "activate", availability: "available" }] }]}
          onAction={onAction}
        />,
      );
      fireEvent.click(
        kind === "connect"
          ? within(screen.getByRole("article", { name: "Ledger" })).getByRole("button", {
              name: "Connect account",
            })
          : within(firstAccount()).getByRole("button", { name: "Activate for this app" }),
      );
      expect(onAction).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Action completed"));
      expect(onAction).toHaveBeenCalledWith({
        kind,
        providerId: "ledger",
        ...(kind === "activate" ? { accountId: "account-1" } : {}),
      });
    },
  );

  it("holds pending, hides unsafe errors, retries exactly and ends after completion", async () => {
    let reject!: (error: Error) => void;
    const onAction = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, fail) => {
            reject = fail;
          }),
      )
      .mockResolvedValue(undefined);
    render(<IntegrationsSurface {...data} onAction={onAction} />);
    fireEvent.click(within(firstAccount()).getByRole("button", { name: "Reconnect" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("button", { name: "Working…" })).toBeDisabled();
    expect(
      within(firstAccount()).getByRole("button", { name: "Disconnect from organization" }),
    ).toBeDisabled();
    await act(async () => reject(new Error("private-provider-secret")));
    expect(screen.getByRole("alert")).toHaveTextContent("could not be completed");
    expect(screen.queryByText("private-provider-secret")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Action completed"));
    expect(onAction).toHaveBeenCalledTimes(2);
    expect(onAction.mock.calls[0]).toEqual(onAction.mock.calls[1]);
  });

  it("rechecks permissions if host data changes during a review", () => {
    const onAction = vi.fn();
    const { rerender } = render(<IntegrationsSurface {...data} onAction={onAction} />);
    fireEvent.click(within(firstAccount()).getByRole("button", { name: "Reconnect" }));
    rerender(
      <IntegrationsSurface
        {...data}
        accounts={[
          {
            ...account,
            actions: [
              { kind: "reconnect", availability: "unavailable", reason: "Permission revoked" },
            ],
          },
        ]}
        onAction={onAction}
      />,
    );
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    fireEvent.submit(screen.getByRole("form", { name: "Reconnect" }));
    expect(onAction).not.toHaveBeenCalled();
  });

  it("keeps partial data visible with independent loading/error sections and refresh retry", async () => {
    const onRefresh = vi
      .fn()
      .mockRejectedValueOnce(new Error("private error"))
      .mockResolvedValue(undefined);
    render(
      <IntegrationsSurface
        {...data}
        state={{
          accounts: { status: "error", message: "Some accounts could not be loaded" },
          activity: { status: "loading" },
        }}
        onRefresh={onRefresh}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Some accounts");
    expect(firstAccount()).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("Loading integration data");
    fireEvent.click(screen.getByRole("button", { name: "Refresh integrations" }));
    fireEvent.click(await screen.findByRole("button", { name: "Retry refresh" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Refresh integrations" })).toBeEnabled(),
    );
    expect(onRefresh).toHaveBeenCalledTimes(2);
  });

  it("supports section visibility without changing capabilities", () => {
    render(
      <IntegrationsSurface
        {...data}
        sections={{ catalog: false, health: false, activity: false }}
      />,
    );
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    expect(screen.queryByText("Integration health")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Recent activity" })).not.toBeInTheDocument();
    expect(firstAccount()).toBeVisible();
    expect(within(firstAccount()).getByRole("button", { name: "Reconnect" })).toBeDisabled();
  });
});

it.each(["loading", "error", "ready"] as const)(
  "empty catalog describes its actual %s state",
  (status) => {
    render(
      <IntegrationsSurface
        {...data}
        providers={[]}
        state={{
          catalog:
            status === "error" ? { status, message: "Provider discovery unavailable" } : { status },
        }}
      />,
    );
    if (status === "ready")
      expect(screen.getByText("No integrations are available.")).toBeInTheDocument();
    else expect(screen.queryByText("No integrations are available.")).not.toBeInTheDocument();
    if (status === "error")
      expect(screen.getByText("Provider discovery unavailable")).toBeInTheDocument();
    expect(screen.getByText("North company")).toBeInTheDocument();
    expect(screen.getByText("Import completed")).toBeInTheDocument();
  },
);

it("hidden catalog does not promise an unavailable connect action in the account empty state", () => {
  render(<IntegrationsSurface {...data} accounts={[]} sections={{ catalog: false }} />);
  expect(screen.getByText("No connected accounts yet.")).toBeInTheDocument();
  expect(screen.queryByText(/Connect an account below/)).not.toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Available integrations" })).not.toBeInTheDocument();
});

it("visible available providers retain the empty-account connection prompt", () => {
  render(<IntegrationsSurface {...data} accounts={[]} />);
  expect(screen.getByText(/Connect an account below/)).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Available integrations" })).toBeInTheDocument();
});
