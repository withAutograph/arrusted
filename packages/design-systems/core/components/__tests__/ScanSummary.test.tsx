// ScanSummary's contract is that a reader can check every figure without
// interacting: the ring is spoken, the rail is plain text, and a nearly-done
// scan never rounds up into looking finished.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";

import { Check, CurrencyDollar, ListBullet } from "../../icons";
import { ScanSummary } from "../ScanSummary";

const STEPS = [
  { icon: Check, label: "Scan complete", detail: "Jul 14, 2026" },
  { icon: ListBullet, label: "12 decisions remaining", detail: "Across 5 review areas" },
  {
    icon: CurrencyDollar,
    label: "$1.6M to clean up",
    detail: "Across flagged items",
    state: "pending" as const,
  },
];

describe("ScanSummary", () => {
  it("renders every step label and its basis without interaction", () => {
    render(
      <ScanSummary progress={0.5} progressLabel="796 of 1592 transactions settled" steps={STEPS} />,
    );
    for (const step of STEPS) {
      expect(screen.getByText(step.label)).toBeInTheDocument();
      expect(screen.getByText(step.detail)).toBeInTheDocument();
    }
  });

  it("marks an unfinished step as pending so the rail is not all filled in", () => {
    const { container } = render(
      <ScanSummary progress={0.5} progressLabel="796 of 1592 settled" steps={STEPS} />,
    );
    const markers = container.querySelectorAll("[data-scan-summary-marker]");
    expect(Array.from(markers).map((el) => el.getAttribute("data-state"))).toEqual([
      "done",
      "done",
      "pending",
    ]);
  });

  it("announces each step's state rather than only colouring it", () => {
    // `data-state` and the marker fill are visual, and the icon is hidden from
    // assistive technology, so a screen reader given only those hears a
    // finished step and an unfinished one as the same thing. Asserting the
    // attribute alone would let that regress without a test noticing.
    render(<ScanSummary progress={0.5} progressLabel="796 of 1592 settled" steps={STEPS} />);
    expect(screen.getAllByText("Done:")).toHaveLength(2);
    expect(screen.getAllByText("Waiting:")).toHaveLength(1);
  });

  it("gives the ring a spoken label rather than leaving it to the percentage alone", () => {
    render(<ScanSummary progress={0.25} progressLabel="1 of 4 records settled" steps={STEPS} />);
    expect(screen.getByRole("img", { name: "1 of 4 records settled" })).toBeInTheDocument();
    expect(screen.getByText("25%")).toBeInTheDocument();
    expect(screen.getByText("ready")).toBeInTheDocument();
  });

  it("never rounds an unfinished scan up to 100%", () => {
    render(<ScanSummary progress={0.999} progressLabel="1591 of 1592 settled" steps={STEPS} />);
    // The one remaining row is the entire point of the screen.
    expect(screen.getByText("99%")).toBeInTheDocument();
  });

  it("shows 100% only when nothing is left", () => {
    render(<ScanSummary progress={1} progressLabel="1592 of 1592 settled" steps={STEPS} />);
    expect(screen.getByText("100%")).toBeInTheDocument();
  });

  it("clamps a progress value outside 0..1 instead of drawing past the ring", () => {
    render(<ScanSummary progress={Number.NaN} progressLabel="nothing scanned" steps={STEPS} />);
    expect(screen.getByText("0%")).toBeInTheDocument();
  });

  it("renders a caveat note where a reader will see it", () => {
    render(
      <ScanSummary
        progress={0.4}
        progressLabel="2 of 5 settled"
        steps={STEPS}
        note="3 records could not be judged: A-12, A-14, A-19"
      />,
    );
    expect(screen.getByText("3 records could not be judged: A-12, A-14, A-19")).toBeInTheDocument();
  });
});
