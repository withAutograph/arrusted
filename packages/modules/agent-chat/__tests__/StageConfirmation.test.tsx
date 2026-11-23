// StageConfirmation partial-add tests (§6 + L2 overflow cap).
//
// The partial-add variant offers the passing subset and lists the failed
// writes; the list is capped (first N + "+N more") like the target chips so a
// large failure set can't blow out the panel. The no-partial case is unchanged.

import { describe, expect, it, vi } from "vite-plus/test";
import { render } from "@testing-library/react";

import { StageConfirmation } from "../StageConfirmation";
import type { StageProposalView } from "../types";

const base: StageProposalView = {
  headline: "base pay +4%",
  changeCount: 3,
  targets: ["Eng Mgr", "PM II"],
};

describe("StageConfirmation partial-add", () => {
  it("caps the failure list and shows a '+N more' overflow (L2)", () => {
    const failures = Array.from({ length: 9 }, (_, i) => ({
      target: `Role ${i + 1} · base pay`,
      reason: "above the band max",
    }));
    const { getByText, queryByText } = render(
      <StageConfirmation
        proposal={{ ...base, partial: { passedCount: 3, failures } }}
        onStage={vi.fn()}
        onDiscard={vi.fn()}
      />,
    );
    // First 6 render; the 7th+ collapse into "+3 more".
    expect(getByText("Role 6 · base pay")).toBeTruthy();
    expect(queryByText("Role 7 · base pay")).toBeNull();
    expect(getByText("+3 more")).toBeTruthy();
    // Primary action offers the passing subset.
    expect(getByText("Add the 3 that passed")).toBeTruthy();
  });

  it("renders no failure list and the default action when partial is absent (no-op)", () => {
    const { queryByText, getByText } = render(
      <StageConfirmation proposal={base} onStage={vi.fn()} onDiscard={vi.fn()} />,
    );
    expect(queryByText(/more$/)).toBeNull();
    expect(queryByText(/didn't pass/)).toBeNull();
    expect(getByText("Add to grid")).toBeTruthy();
  });
});
