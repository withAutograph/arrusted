// PreviewSaveTabs — structural + slot contract.
//
// Covers: one tab per `tabs[]` entry, synthetic Issues tab derivation, the
// aria-selected wiring, click → onActiveTabChange, and that the body slot is
// invoked once per render with the current active tab id. Visual underline
// chrome lives in CSS; structural tests pin the data-attribute the styles
// hook off of.

import { useState } from "react";

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";

import { PREVIEW_ERRORS_TAB_ID, PreviewSaveTabs } from "../components/PreviewSaveTabs";
import type { PreviewModelTab } from "../types";

function makeTab(overrides: Partial<PreviewModelTab>): PreviewModelTab {
  return {
    modelId: "model_alpha",
    label: "Alpha",
    rowCount: 10,
    readyRowCount: 10,
    needsReviewRowCount: 0,
    parseErrorRowCount: 0,
    ...overrides,
  };
}

describe("PreviewSaveTabs", () => {
  it("renders a tab per `tabs[]` entry with the host-supplied label", () => {
    const tabs: PreviewModelTab[] = [
      makeTab({ modelId: "model_alpha", label: "Alpha", rowCount: 12 }),
      makeTab({ modelId: "model_beta", label: "Beta", rowCount: 3 }),
    ];
    render(
      <PreviewSaveTabs
        tabs={tabs}
        activeTabId="model_alpha"
        onActiveTabChange={() => {}}
        renderActiveBody={() => <div>body</div>}
      />,
    );
    const renderedTabs = screen.getAllByRole("tab");
    expect(renderedTabs).toHaveLength(2);
    expect(renderedTabs[0]).toHaveTextContent("Alpha");
    expect(renderedTabs[1]).toHaveTextContent("Beta");
  });

  it("synthesizes an Issues tab when any tab has parseErrorRowCount > 0", () => {
    const tabs: PreviewModelTab[] = [
      makeTab({ modelId: "model_alpha", label: "Alpha", parseErrorRowCount: 2 }),
      makeTab({ modelId: "model_beta", label: "Beta", parseErrorRowCount: 1 }),
    ];
    render(
      <PreviewSaveTabs
        tabs={tabs}
        activeTabId="model_alpha"
        onActiveTabChange={() => {}}
        renderActiveBody={() => <div>body</div>}
      />,
    );
    const renderedTabs = screen.getAllByRole("tab");
    expect(renderedTabs).toHaveLength(3);
    const issuesTab = renderedTabs[2];
    // The synthetic tab is labeled "Issues" and shows the aggregate count.
    expect(issuesTab).toHaveTextContent("Issues");
    expect(issuesTab).toHaveTextContent("3 issues");
    expect(issuesTab).toHaveAttribute("data-tab-id", PREVIEW_ERRORS_TAB_ID);
  });

  it("does NOT synthesize an Issues tab when every tab has zero issue counts", () => {
    const tabs: PreviewModelTab[] = [
      makeTab({ modelId: "model_alpha", label: "Alpha" }),
      makeTab({ modelId: "model_beta", label: "Beta" }),
    ];
    render(
      <PreviewSaveTabs
        tabs={tabs}
        activeTabId="model_alpha"
        onActiveTabChange={() => {}}
        renderActiveBody={() => <div>body</div>}
      />,
    );
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    expect(screen.queryByText("Issues")).toBeNull();
  });

  it("marks the active tab with aria-selected=true and inactives with aria-selected=false", () => {
    const tabs: PreviewModelTab[] = [
      makeTab({ modelId: "model_alpha", label: "Alpha" }),
      makeTab({ modelId: "model_beta", label: "Beta" }),
    ];
    render(
      <PreviewSaveTabs
        tabs={tabs}
        activeTabId="model_beta"
        onActiveTabChange={() => {}}
        renderActiveBody={() => <div>body</div>}
      />,
    );
    const active = screen.getByRole("tab", { selected: true });
    expect(active).toHaveTextContent("Beta");
    const alpha = screen.getByRole("tab", { name: /Alpha/ });
    expect(alpha).toHaveAttribute("aria-selected", "false");
  });

  it("renders the correct status chip per-tab (issues > needs-review > ready)", () => {
    const tabs: PreviewModelTab[] = [
      // Ready tab — even if parse errors exist on a sibling, this tab itself
      // is clean and should still read as success.
      makeTab({ modelId: "model_alpha", label: "Alpha", rowCount: 10, readyRowCount: 10 }),
      makeTab({
        modelId: "model_beta",
        label: "Beta",
        rowCount: 10,
        readyRowCount: 7,
        needsReviewRowCount: 3,
      }),
      makeTab({
        modelId: "model_gamma",
        label: "Gamma",
        rowCount: 10,
        readyRowCount: 5,
        needsReviewRowCount: 3,
        parseErrorRowCount: 2,
      }),
    ];
    render(
      <PreviewSaveTabs
        tabs={tabs}
        activeTabId="model_alpha"
        onActiveTabChange={() => {}}
        renderActiveBody={() => <div>body</div>}
      />,
    );
    expect(screen.getByText("10 ready")).toBeInTheDocument();
    expect(screen.getByText("3 to review")).toBeInTheDocument();
    // Gamma tab shows danger because parse issues win precedence over
    // needs-review on the same tab. The synthetic Issues tab aggregates
    // both parse and review issues across every tab.
    expect(screen.getByText("2 issues")).toBeInTheDocument();
    expect(screen.getByText("8 issues")).toBeInTheDocument();
    const gamma = screen.getByRole("tab", { name: /Gamma/ });
    expect(gamma).toHaveTextContent("10");
    expect(gamma).not.toHaveTextContent("5");
  });

  it("calls onActiveTabChange with the tab id when an inactive tab is clicked", () => {
    const tabs: PreviewModelTab[] = [
      makeTab({ modelId: "model_alpha", label: "Alpha" }),
      makeTab({ modelId: "model_beta", label: "Beta" }),
    ];
    const onActiveTabChange = vi.fn();
    render(
      <PreviewSaveTabs
        tabs={tabs}
        activeTabId="model_alpha"
        onActiveTabChange={onActiveTabChange}
        renderActiveBody={() => <div>body</div>}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: /Beta/ }));
    expect(onActiveTabChange).toHaveBeenCalledTimes(1);
    expect(onActiveTabChange).toHaveBeenCalledWith("model_beta");
  });

  it("does not call onActiveTabChange when the active tab is clicked", () => {
    const tabs: PreviewModelTab[] = [makeTab({ modelId: "model_alpha", label: "Alpha" })];
    const onActiveTabChange = vi.fn();
    render(
      <PreviewSaveTabs
        tabs={[...tabs, makeTab({ modelId: "model_beta", label: "Beta" })]}
        activeTabId="model_alpha"
        onActiveTabChange={onActiveTabChange}
        renderActiveBody={() => <div>body</div>}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: /Alpha/ }));
    expect(onActiveTabChange).not.toHaveBeenCalled();
  });

  it("invokes renderActiveBody with the active tab id and renders its output", () => {
    const tabs: PreviewModelTab[] = [
      makeTab({ modelId: "model_alpha", label: "Alpha" }),
      makeTab({ modelId: "model_beta", label: "Beta" }),
    ];
    const renderActiveBody = vi.fn((tabId: string) => (
      <div data-testid="active-body">body-for-{tabId}</div>
    ));
    render(
      <PreviewSaveTabs
        tabs={tabs}
        activeTabId="model_beta"
        onActiveTabChange={() => {}}
        renderActiveBody={renderActiveBody}
      />,
    );
    // The slot is called exactly once per render with the active tab id; the
    // body container hosts only the active panel.
    expect(renderActiveBody).toHaveBeenCalledTimes(1);
    expect(renderActiveBody).toHaveBeenCalledWith("model_beta");
    expect(screen.getByTestId("active-body")).toHaveTextContent("body-for-model_beta");
  });

  it("moves focus + activates the next tab on ArrowRight", async () => {
    // WAI-ARIA tablist automatic-activation pattern: ArrowRight from the
    // focused active tab should advance focus AND fire onActiveTabChange
    // so the body slot follows. Pins both halves of the contract.
    const tabs: PreviewModelTab[] = [
      makeTab({ modelId: "model_alpha", label: "Alpha" }),
      makeTab({ modelId: "model_beta", label: "Beta" }),
    ];
    function Harness() {
      const [active, setActive] = useState("model_alpha");
      return (
        <PreviewSaveTabs
          tabs={tabs}
          activeTabId={active}
          onActiveTabChange={setActive}
          renderActiveBody={(id) => <div data-testid="active-body">id={id}</div>}
        />
      );
    }
    render(<Harness />);
    const alpha = screen.getByRole("tab", { name: /Alpha/ });
    alpha.focus();
    fireEvent.keyDown(alpha, { key: "ArrowRight" });
    // Focus + activation both move to Beta. Wait a tick for the
    // queueMicrotask in the handler to flush.
    await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));
    const beta = screen.getByRole("tab", { name: /Beta/ });
    expect(beta).toHaveAttribute("aria-selected", "true");
    expect(document.activeElement).toBe(beta);
    expect(screen.getByTestId("active-body")).toHaveTextContent("id=model_beta");
  });

  it("wraps ArrowLeft from the first tab to the last (Issues tab if present)", async () => {
    // ArrowLeft from index 0 should land on the Issues tab when one is
    // synthesized, exercising both wrap-around and the synthetic-tab
    // case in one shot.
    const tabs: PreviewModelTab[] = [
      makeTab({ modelId: "model_alpha", label: "Alpha", parseErrorRowCount: 1 }),
      makeTab({ modelId: "model_beta", label: "Beta" }),
    ];
    function Harness() {
      const [active, setActive] = useState("model_alpha");
      return (
        <PreviewSaveTabs
          tabs={tabs}
          activeTabId={active}
          onActiveTabChange={setActive}
          renderActiveBody={(id) => <div data-testid="active-body">id={id}</div>}
        />
      );
    }
    render(<Harness />);
    const alpha = screen.getByRole("tab", { name: /Alpha/ });
    alpha.focus();
    fireEvent.keyDown(alpha, { key: "ArrowLeft" });
    await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));
    const issuesTab = screen.getByRole("tab", { name: /Issues/ });
    expect(issuesTab).toHaveAttribute("aria-selected", "true");
    expect(document.activeElement).toBe(issuesTab);
  });

  it("rerenders the body slot with the new tab id after onActiveTabChange swaps active state", () => {
    // Controlled harness so the test mirrors how the host wires this composite.
    const tabs: PreviewModelTab[] = [
      makeTab({ modelId: "model_alpha", label: "Alpha" }),
      makeTab({ modelId: "model_beta", label: "Beta" }),
    ];
    function Harness() {
      const [active, setActive] = useState("model_alpha");
      return (
        <PreviewSaveTabs
          tabs={tabs}
          activeTabId={active}
          onActiveTabChange={setActive}
          renderActiveBody={(id) => <div data-testid="active-body">id={id}</div>}
        />
      );
    }
    render(<Harness />);
    expect(screen.getByTestId("active-body")).toHaveTextContent("id=model_alpha");
    fireEvent.click(screen.getByRole("tab", { name: /Beta/ }));
    expect(screen.getByTestId("active-body")).toHaveTextContent("id=model_beta");
  });
});
