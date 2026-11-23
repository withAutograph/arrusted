// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { CurrencyRateEditor, type CurrencyRateEditorProps } from "../CurrencyRateEditor";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 2, 1, 12));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const rates: CurrencyRateEditorProps["rates"] = [
  {
    sourceCurrency: "EUR",
    targetCurrency: "USD",
    rate: "1.123456789",
    effectiveStart: "2026-02-01",
    effectiveEnd: null,
    origin: "custom",
    versionId: "custom-current",
  },
  {
    sourceCurrency: "EUR",
    targetCurrency: "USD",
    rate: "1.1",
    effectiveStart: "2026-01-01",
    effectiveEnd: "2026-02-01",
    origin: "frankfurter",
    observationDate: "2025-12-31",
  },
];
async function setup(overrides: Partial<CurrencyRateEditorProps> = {}) {
  const props: CurrencyRateEditorProps = {
    sourceCurrency: "EUR",
    targetCurrency: "USD",
    rates,
    onSave: vi.fn().mockResolvedValue(undefined),
    onUseAutomatic: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  const view = render(<CurrencyRateEditor {...props} />);
  await screen.findByRole("columnheader", { name: "Starts on" });
  return { ...view, props };
}
function fill(rate = "1.234567890123456789") {
  fireEvent.change(screen.getByLabelText("Rate"), { target: { value: rate } });
}

describe("CurrencyRateEditor", () => {
  it("opens an open-ended draft on demand and discards it on cancel", async () => {
    const { props } = await setup();
    expect(screen.queryByLabelText("Rate")).not.toBeInTheDocument();
    vi.setSystemTime(new Date(2026, 2, 2, 12));
    fireEvent.click(screen.getByRole("button", { name: "Add rate" }));
    await screen.findByLabelText("Rate");
    expect(screen.getByLabelText("Period start")).toHaveTextContent("Mar 02, 2026");
    expect(screen.getByRole("checkbox", { name: "No end date" })).toBeChecked();
    expect(screen.queryByLabelText("Period end (inclusive)")).not.toBeInTheDocument();
    fill();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("Rate")).not.toBeInTheDocument();
    expect(props.onSave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Add rate" }));
    await screen.findByLabelText("Rate");
    expect(screen.getByLabelText("Rate")).toHaveValue("");
  });

  it("keeps focus and every typed digit in an inline draft", async () => {
    const { props } = await setup();
    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByRole("button", { name: "Add rate" }));
    const input = await screen.findByLabelText("Rate");
    await user.type(input, "1.1234567890123456789");
    expect(input).toHaveFocus();
    expect(input).toHaveValue("1.1234567890123456789");
    await user.click(screen.getByRole("button", { name: "Save rate" }));
    expect(props.onSave).toHaveBeenCalledWith({
      sourceCurrency: "EUR",
      targetCurrency: "USD",
      rate: "1.1234567890123456789",
      effectiveStart: "2026-03-01",
      effectiveEnd: null,
    });
  });

  it("shows precise values and provenance, with editing only for custom history", async () => {
    await setup();
    const table = screen.getByRole("grid");
    expect(within(table).getByText("1.123456789")).toBeVisible();
    expect(screen.getByText("Reference date Dec 31, 2025")).toBeVisible();
    expect(screen.getAllByRole("grid")).toHaveLength(1);
    expect(within(table).getByText("1.1")).toBeVisible();
    expect(within(table).getAllByRole("button", { name: /Edit custom rate/ })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Edit custom rate starting 2026-02-01" }));
    await screen.findByLabelText("Rate");
    expect(screen.getByLabelText("Rate")).toHaveValue("1.123456789");
    expect(screen.getByLabelText("Period start")).toHaveTextContent("Feb 01, 2026");
    expect(screen.getByLabelText("Rate").closest('[role="row"]')).toHaveStyle({ height: "88px" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    const edit = await screen.findByRole("button", {
      name: "Edit custom rate starting 2026-02-01",
    });
    expect(edit.closest('[role="row"]')).toHaveStyle({ height: "52px" });
  });

  it("saves the entered inverse quote unchanged and reopens it in that direction", async () => {
    const { props, rerender } = await setup();
    fireEvent.click(screen.getByRole("button", { name: "Add rate" }));
    await screen.findByLabelText("Rate");
    fill("0.9132");
    fireEvent.click(screen.getByRole("radio", { name: "USD → EUR" }));
    expect(screen.getByLabelText("Rate")).toHaveValue("0.9132");
    fireEvent.click(screen.getByRole("button", { name: "Save rate" }));
    const saved = {
      sourceCurrency: "USD",
      targetCurrency: "EUR",
      rate: "0.9132",
      effectiveStart: "2026-03-01",
      effectiveEnd: null,
    };
    await waitFor(() => expect(props.onSave).toHaveBeenCalledWith(saved));
    await waitFor(() => expect(screen.queryByLabelText("Rate")).not.toBeInTheDocument());
    rerender(
      <CurrencyRateEditor
        {...props}
        rates={[
          { ...saved, origin: "custom" },
          { ...rates[1]!, effectiveEnd: null },
        ]}
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Edit custom rate starting 2026-03-01" }),
    );
    await screen.findByLabelText("Rate");
    expect(screen.getByRole("radio", { name: "USD → EUR" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByLabelText("Rate")).toHaveValue("0.9132");
  });

  it("hides a default fully covered by a custom override and clips partial coverage", async () => {
    const { rerender, props } = await setup({
      rates: [rates[0]!, { ...rates[1]!, effectiveStart: "2026-02-01", effectiveEnd: null }],
    });
    expect(screen.queryByText("1.1")).not.toBeInTheDocument();
    expect(screen.queryByText(/Automatic · Frankfurter/)).not.toBeInTheDocument();
    rerender(
      <CurrencyRateEditor
        {...props}
        rates={[
          { ...rates[0]!, effectiveStart: "2026-02-10", effectiveEnd: "2026-02-20" },
          { ...rates[1]!, effectiveStart: "2026-02-01", effectiveEnd: null },
        ]}
      />,
    );
    await waitFor(() => expect(screen.getAllByText("1.1")).toHaveLength(2));
    expect(screen.getByText("Feb 9, 2026")).toBeVisible();
    expect(screen.getByText("Feb 21, 2026")).toBeVisible();
  });

  it("locks the existing start for corrections and explicitly resets for a new period", async () => {
    const { props } = await setup();
    fireEvent.click(screen.getByRole("button", { name: "Edit custom rate starting 2026-02-01" }));
    await screen.findByLabelText("Rate");
    expect(screen.getByLabelText("Period start")).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Rate"), { target: { value: "1.2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save rate" }));
    await waitFor(() =>
      expect(props.onSave).toHaveBeenCalledWith({
        sourceCurrency: "EUR",
        targetCurrency: "USD",
        rate: "1.2",
        effectiveStart: "2026-02-01",
        effectiveEnd: null,
        previousEffectiveEnd: null,
        expectedVersionId: "custom-current",
      }),
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Add rate" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Add rate" }));
    await screen.findByLabelText("Rate");
    expect(screen.getByLabelText("Period start")).toBeEnabled();
    expect(screen.getByLabelText("Period start")).toHaveTextContent("Mar 01, 2026");
    expect(screen.getByLabelText("Rate")).toHaveValue("");
    expect(screen.getByRole("checkbox", { name: "No end date" })).toBeChecked();
    fill("1.3");
    fireEvent.click(screen.getByRole("button", { name: "Save rate" }));
    await waitFor(() =>
      expect(props.onSave).toHaveBeenLastCalledWith({
        sourceCurrency: "EUR",
        targetCurrency: "USD",
        rate: "1.3",
        effectiveStart: "2026-03-01",
        effectiveEnd: null,
      }),
    );
  });

  it("preserves the draft and history during save, passes decimal strings, and waits for caller refresh", async () => {
    let resolve!: () => void;
    const onSave = vi.fn(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    await setup({ onSave });
    fireEvent.click(screen.getByRole("button", { name: "Add rate" }));
    await screen.findByLabelText("Rate");
    fill();
    fireEvent.click(screen.getByRole("button", { name: "Save rate" }));
    expect(onSave).toHaveBeenCalledWith({
      sourceCurrency: "EUR",
      targetCurrency: "USD",
      rate: "1.234567890123456789",
      effectiveStart: "2026-03-01",
      effectiveEnd: null,
    });
    expect(screen.getByLabelText("Rate")).toBeDisabled();
    expect(screen.getByText("1.123456789")).toBeVisible();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add rate" })).toBeDisabled();
    await act(async () => resolve());
    expect(screen.queryByLabelText("Rate")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Custom rate saved.");
    expect(screen.getByText("1.123456789")).toBeVisible();
  });

  it("retains rejected edits and allows retry", async () => {
    const onSave = vi
      .fn()
      .mockRejectedValueOnce(new Error("Save failed"))
      .mockResolvedValue(undefined);
    await setup({ onSave });
    fireEvent.click(screen.getByRole("button", { name: "Add rate" }));
    await screen.findByLabelText("Rate");
    fill();
    fireEvent.click(screen.getByRole("button", { name: "Save rate" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Save failed");
    expect(screen.getByLabelText("Rate")).toHaveValue("1.234567890123456789");
    fireEvent.click(screen.getByRole("button", { name: "Save rate" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Custom rate saved."));
    expect(onSave).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid rates and reversed periods before invoking persistence", async () => {
    const { props } = await setup();
    fireEvent.click(screen.getByRole("button", { name: "Add rate" }));
    await screen.findByLabelText("Rate");
    fill("0");
    fireEvent.click(screen.getByRole("button", { name: "Save rate" }));
    expect(screen.getByRole("alert")).toBeVisible();
    expect(props.onSave).not.toHaveBeenCalled();
    fill();
    fireEvent.click(screen.getByRole("checkbox", { name: "No end date" }));
    fireEvent.click(screen.getByRole("button", { name: "Save rate" }));
    expect(props.onSave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText("Period end (inclusive)"));
    fireEvent.click(screen.getByRole("button", { name: "Go to the Previous Month" }));
    fireEvent.click(screen.getByRole("button", { name: /February 1st, 2026/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save rate" }));
    expect(screen.getByRole("alert")).toBeVisible();
    expect(props.onSave).not.toHaveBeenCalled();
  });

  it("returns to automatic at the requested date and preserves rejected input", async () => {
    const onUseAutomatic = vi
      .fn()
      .mockRejectedValueOnce(new Error("Unavailable"))
      .mockResolvedValue(undefined);
    await setup({ onUseAutomatic });
    fireEvent.click(screen.getByRole("button", { name: "Use automatic…" }));
    await screen.findByLabelText("Automatic effective from");
    fireEvent.click(screen.getByLabelText("Automatic effective from"));
    fireEvent.click(screen.getByRole("button", { name: "Go to the Next Month" }));
    fireEvent.click(screen.getByRole("button", { name: /April 1st, 2026/ }));
    fireEvent.click(screen.getByRole("button", { name: "Use automatic rates" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Unavailable");
    expect(screen.getByLabelText("Automatic effective from")).toHaveTextContent("Apr 01, 2026");
    fireEvent.click(screen.getByRole("button", { name: "Use automatic rates" }));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "Automatic rates requested successfully.",
      ),
    );
    expect(onUseAutomatic).toHaveBeenLastCalledWith({ effectiveStart: "2026-04-01" });
  });

  it("starts a fresh draft when the supplied currency pair changes", async () => {
    const { props, rerender } = await setup();
    fireEvent.click(screen.getByRole("button", { name: "Add rate" }));
    await screen.findByLabelText("Rate");
    fill();
    rerender(<CurrencyRateEditor {...props} sourceCurrency="GBP" />);
    expect(screen.queryByLabelText("Rate")).not.toBeInTheDocument();
    expect(
      await screen.findByText("No rates yet. Add a custom rate or load automatic rates."),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Add rate" }));
    await screen.findByLabelText("Rate");
    expect(screen.getByLabelText("Rate")).toHaveValue("");
  });
});
