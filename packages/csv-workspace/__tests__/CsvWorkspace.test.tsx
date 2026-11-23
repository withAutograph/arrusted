import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { CsvWorkspace } from "../CsvWorkspace";
import type { CsvWorkspaceContext } from "../types";

vi.mock("../InstalledCsvWorkspace", () => ({
  InstalledCsvWorkspace: ({
    context,
    onRunStart,
    onRunReset,
  }: {
    context: CsvWorkspaceContext;
    onRunStart: () => void;
    onRunReset: () => void;
  }) => (
    <>
      <button onClick={onRunStart}>
        Start {context.scope.customerId} {context.asOf}
      </button>
      <button onClick={onRunReset}>Import another file</button>
      <output>{context.schemaRevisionId}</output>
    </>
  ),
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const props = {
  baseUrl: "/domain/api/csv-workspace",
  expectedScope: { appId: "domain", customerId: "customer" },
  initialAsOf: "2026-09-07",
};
function context(asOf = props.initialAsOf, customerId = "customer", appId = "domain") {
  return { scope: { appId, customerId }, asOf };
}

describe("public CSV workspace composition", () => {
  it("chooses browser calendar date after mount when the host supplies no date", async () => {
    vi.spyOn(Date.prototype, "getFullYear").mockReturnValue(2026);
    vi.spyOn(Date.prototype, "getMonth").mockReturnValue(8);
    vi.spyOn(Date.prototype, "getDate").mockReturnValue(7);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) =>
        Response.json(context(new URL(input, "https://example.test").searchParams.get("as_of")!)),
      ),
    );
    render(<CsvWorkspace {...props} initialAsOf={undefined} />);
    expect(
      await screen.findByRole("button", { name: "Start customer 2026-09-07" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Effective date")).toHaveValue("2026-09-07");
  });
  it("loads with session credentials, reloads a chosen date, and freezes it at run start", async () => {
    const fetch = vi.fn(async (input: string) =>
      Response.json(context(new URL(input, "https://example.test").searchParams.get("as_of")!)),
    );
    vi.stubGlobal("fetch", fetch);
    render(<CsvWorkspace {...props} />);
    expect(screen.getByText("Loading CSV workspace…")).toBeInTheDocument();
    await screen.findByRole("button", { name: "Start customer 2026-09-07" });
    expect(fetch).toHaveBeenCalledWith(
      "/domain/api/csv-workspace/workspace?as_of=2026-09-07",
      expect.objectContaining({ credentials: "same-origin" }),
    );
    fireEvent.change(screen.getByLabelText("Effective date"), { target: { value: "2026-09-08" } });
    const start = await screen.findByRole("button", { name: "Start customer 2026-09-08" });
    fireEvent.click(start);
    expect(screen.getByLabelText("Effective date")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Import another file" }));
    expect(screen.getByLabelText("Effective date")).toBeEnabled();
    fireEvent.change(screen.getByLabelText("Effective date"), { target: { value: "2026-09-09" } });
    fireEvent.click(await screen.findByRole("button", { name: "Start customer 2026-09-09" }));
    expect(screen.getByLabelText("Effective date")).toBeDisabled();
  });
  it("reloads the active schema on restart while preserving the chosen date", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ ...context(), schemaRevisionId: "old-revision" }))
      .mockResolvedValueOnce(Response.json({ ...context(), schemaRevisionId: "new-revision" }));
    vi.stubGlobal("fetch", fetch);
    render(<CsvWorkspace {...props} />);
    await screen.findByText("old-revision");
    fireEvent.click(screen.getByRole("button", { name: "Import another file" }));
    await screen.findByText("new-revision");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText("Effective date")).toHaveValue(props.initialAsOf);
  });
  it.each([
    [context(props.initialAsOf, "other"), "different authenticated organization"],
    [context(props.initialAsOf, "customer", "other"), "different authenticated organization"],
    [context("2026-09-09"), "different effective date"],
  ])(
    "does not mount a workspace whose server context mismatches the host",
    async (loaded, message) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json(loaded)),
      );
      render(<CsvWorkspace {...props} />);
      expect(await screen.findByRole("alert")).toHaveTextContent(message);
      expect(screen.queryByRole("button", { name: /Start/ })).not.toBeInTheDocument();
    },
  );
  it("ignores an older date response even if transport delivers it after abort", async () => {
    let resolveOld!: (response: Response) => void;
    const fetch = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockResolvedValueOnce(Response.json(context("2026-09-08")));
    vi.stubGlobal("fetch", fetch);
    render(<CsvWorkspace {...props} />);
    fireEvent.change(screen.getByLabelText("Effective date"), { target: { value: "2026-09-08" } });
    await screen.findByRole("button", { name: "Start customer 2026-09-08" });
    await act(async () => resolveOld(Response.json(context())));
    expect(screen.getByRole("button", { name: "Start customer 2026-09-08" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Start customer 2026-09-07" }),
    ).not.toBeInTheDocument();
    expect(fetch.mock.calls[0]![1].signal.aborted).toBe(true);
  });
  it("resets the run and drops old content when authenticated organization changes", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json(context()))
      .mockResolvedValueOnce(Response.json(context(props.initialAsOf, "next")));
    vi.stubGlobal("fetch", fetch);
    const view = render(<CsvWorkspace {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: /Start customer/ }));
    view.rerender(
      <CsvWorkspace {...props} expectedScope={{ appId: "domain", customerId: "next" }} />,
    );
    expect(screen.queryByRole("button", { name: /Start customer/ })).not.toBeInTheDocument();
    await screen.findByRole("button", { name: /Start next/ });
    await waitFor(() => expect(screen.getByLabelText("Effective date")).toBeEnabled());
  });
});
