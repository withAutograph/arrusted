// PreviewSaveBar - count rendering, gating, label rules, and the
// blocking-reason copy.
//
// The Save button is disabled when `blockingReason` is set OR when
// `saving` is true. The blocking-reason copy is locked at the prompt
// level; this suite pins every variant string so a future copy change
// is a visible diff, not silent drift.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";

import { PreviewSaveBar } from "../components/PreviewSaveBar";
import type { PreviewSaveBarProps } from "../components/PreviewSaveBar";

function renderBar(overrides: Partial<PreviewSaveBarProps> = {}) {
  const onSave = overrides.onSave ?? vi.fn();
  const defaults: PreviewSaveBarProps = {
    readyRowCount: 5,
    needsReviewRowCount: 0,
    parseErrorRowCount: 0,
    onSave,
    saving: false,
  };
  return {
    onSave,
    ...render(<PreviewSaveBar {...defaults} {...overrides} />),
  };
}

describe("PreviewSaveBar", () => {
  describe("count rendering", () => {
    it("renders the unchanged chip only when unchanged rows exist", () => {
      const { rerender } = render(
        <PreviewSaveBar
          readyRowCount={2}
          needsReviewRowCount={0}
          parseErrorRowCount={0}
          unchangedRowCount={3}
          onSave={vi.fn()}
          saving={false}
        />,
      );
      expect(screen.getByText("unchanged")).toBeInTheDocument();
      expect(screen.getByText("3")).toBeInTheDocument();
      rerender(
        <PreviewSaveBar
          readyRowCount={2}
          needsReviewRowCount={0}
          parseErrorRowCount={0}
          onSave={vi.fn()}
          saving={false}
        />,
      );
      expect(screen.queryByText("unchanged")).not.toBeInTheDocument();
    });

    it("renders ready, to-review, and parse-error counts", () => {
      renderBar({
        readyRowCount: 39,
        needsReviewRowCount: 7,
        parseErrorRowCount: 1,
      });
      // Count labels are rendered via the success/warning/danger StatusPill
      // primitives; values are the numeric leading spans.
      expect(screen.getByText("39")).toBeInTheDocument();
      expect(screen.getByText("7")).toBeInTheDocument();
      expect(screen.getByText("1")).toBeInTheDocument();
      expect(screen.getByText(/ready/)).toBeInTheDocument();
      expect(screen.getByText(/to review/)).toBeInTheDocument();
      expect(screen.getByText(/issue/)).toBeInTheDocument();
    });
  });

  describe("Save button label", () => {
    it("shows `Save N changes` when enabled and readyRowCount > 1", () => {
      renderBar({ readyRowCount: 39 });
      expect(screen.getByRole("button", { name: "Save 39 changes" })).toBeEnabled();
    });

    it("singularizes to `Save 1 change` when exactly one row is ready", () => {
      renderBar({ readyRowCount: 1 });
      expect(screen.getByRole("button", { name: "Save 1 change" })).toBeEnabled();
    });

    it("uses a caller-provided save label when the host owns mode-specific copy", () => {
      renderBar({ readyRowCount: 39, saveLabel: "Save 39 drafts" });
      expect(screen.getByRole("button", { name: "Save 39 drafts" })).toBeEnabled();
    });

    it("falls back to plain `Save` when readyRowCount is zero", () => {
      // readyRowCount === 0 would typically coincide with the `no_changes`
      // blocker; this assertion pins the label rule independently.
      renderBar({ readyRowCount: 0, blockingReason: "no_changes" });
      const btn = screen.getByRole("button", { name: "Save" });
      expect(btn).toBeDisabled();
    });
  });

  describe("gating", () => {
    it("disables Save when blockingReason is set and renders the blocking copy", () => {
      const { onSave } = renderBar({
        readyRowCount: 39,
        needsReviewRowCount: 7,
        parseErrorRowCount: 1,
        blockingReason: "needs_review_rows",
      });
      const btn = screen.getByRole("button", { name: /Save/ });
      expect(btn).toBeDisabled();
      // Clicking a disabled button doesn't fire onClick in the DOM model,
      // so the assertion below also pins the disabled wiring.
      fireEvent.click(btn);
      expect(onSave).not.toHaveBeenCalled();
      expect(screen.getByText("7 rows need review before Save can proceed.")).toBeInTheDocument();
    });

    it("enables Save and calls onSave when no blockingReason is provided", () => {
      const { onSave } = renderBar({ readyRowCount: 5 });
      const btn = screen.getByRole("button", { name: "Save 5 changes" });
      expect(btn).toBeEnabled();
      fireEvent.click(btn);
      expect(onSave).toHaveBeenCalledTimes(1);
    });

    it("links the disabled button to the reason text via aria-describedby", () => {
      renderBar({
        blockingReason: "questions_pending",
        readyRowCount: 0,
      });
      const btn = screen.getByRole("button", { name: "Save" });
      const describedBy = btn.getAttribute("aria-describedby");
      expect(describedBy).toBeTruthy();
      const reasonNode = document.getElementById(describedBy!);
      expect(reasonNode).not.toBeNull();
      expect(reasonNode!.textContent).toContain(
        "Finish answering the agent's questions in Clean up data.",
      );
    });

    it("omits aria-describedby when no blockingReason is set", () => {
      renderBar({ readyRowCount: 3 });
      const btn = screen.getByRole("button", { name: "Save 3 changes" });
      expect(btn).not.toHaveAttribute("aria-describedby");
    });
  });

  describe("saving state", () => {
    it("shows `Saving...` and stays disabled while saving", () => {
      const { onSave } = renderBar({ readyRowCount: 5, saving: true });
      const btn = screen.getByRole("button", { name: "Saving..." });
      expect(btn).toBeDisabled();
      fireEvent.click(btn);
      expect(onSave).not.toHaveBeenCalled();
    });

    it("disables Discard all while saving so the user can't drop a mid-flight buffer", () => {
      // Mid-save discard would race with the in-flight apply; pin the safe
      // default so a future refactor doesn't quietly relax it.
      const onDiscardAll = vi.fn();
      renderBar({
        readyRowCount: 5,
        saving: true,
        onDiscardAll,
      });
      const discard = screen.getByRole("button", { name: "Discard all" });
      expect(discard).toBeDisabled();
    });
  });

  describe("Discard all", () => {
    it("renders Discard all only when onDiscardAll is provided", () => {
      const { rerender } = render(
        <PreviewSaveBar
          readyRowCount={0}
          needsReviewRowCount={0}
          parseErrorRowCount={0}
          blockingReason="no_changes"
          onSave={() => {}}
          saving={false}
        />,
      );
      expect(screen.queryByRole("button", { name: "Discard all" })).toBeNull();
      const onDiscardAll = vi.fn();
      rerender(
        <PreviewSaveBar
          readyRowCount={0}
          needsReviewRowCount={0}
          parseErrorRowCount={0}
          blockingReason="no_changes"
          onSave={() => {}}
          onDiscardAll={onDiscardAll}
          saving={false}
        />,
      );
      const discard = screen.getByRole("button", { name: "Discard all" });
      expect(discard).toBeEnabled();
      fireEvent.click(discard);
      expect(onDiscardAll).toHaveBeenCalledTimes(1);
    });
  });

  describe("saveErrorMessage", () => {
    it("renders the save error as an alert and links it via aria-describedby", () => {
      renderBar({
        readyRowCount: 5,
        saveErrorMessage: "Change set `change_alpha` failed",
      });
      const alert = screen.getByRole("alert");
      expect(alert.textContent).toContain("Change set `change_alpha` failed");
      const btn = screen.getByRole("button", { name: "Save 5 changes" });
      const describedBy = btn.getAttribute("aria-describedby");
      expect(describedBy).toBeTruthy();
      expect(document.getElementById(describedBy!)).toBe(alert);
    });

    it("omits the alert when no save error is present", () => {
      renderBar({ readyRowCount: 5 });
      expect(screen.queryByRole("alert")).toBeNull();
    });
  });

  describe("import as-of", () => {
    it("hides the write date until the host supplies one", () => {
      renderBar({ readyRowCount: 5 });
      expect(document.querySelector("[data-import-as-of]")).toBeNull();
      expect(screen.queryByText(/Writing as of /)).toBeNull();
    });

    it("shows the write date as informational copy on the save bar", () => {
      renderBar({ readyRowCount: 5, asOf: "2026-05-24" });
      expect(document.querySelector("[data-import-as-of]")?.getAttribute("data-import-as-of")).toBe(
        "2026-05-24",
      );
      expect(screen.getByText("Writing as of May 24, 2026")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /As of/ })).toBeNull();
    });
  });

  describe("blocking-reason copy", () => {
    // Every variant pinned against the exact string in the prompt.
    it("questions_pending", () => {
      renderBar({ blockingReason: "questions_pending", readyRowCount: 0 });
      expect(
        screen.getByText("Finish answering the agent's questions in Clean up data."),
      ).toBeInTheDocument();
    });

    it("needs_review_rows interpolates the actual count", () => {
      renderBar({
        blockingReason: "needs_review_rows",
        needsReviewRowCount: 4,
        readyRowCount: 3,
      });
      expect(screen.getByText("4 rows need review before Save can proceed.")).toBeInTheDocument();
    });

    it("parse_errors interpolates the actual count", () => {
      renderBar({
        blockingReason: "parse_errors",
        parseErrorRowCount: 2,
        readyRowCount: 0,
      });
      expect(
        screen.getByText("2 issues must be fixed before Save can proceed."),
      ).toBeInTheDocument();
    });

    it("no_changes", () => {
      renderBar({ blockingReason: "no_changes", readyRowCount: 0 });
      expect(screen.getByText("No changes to save.")).toBeInTheDocument();
    });

    it("write_date_pending", () => {
      renderBar({ blockingReason: "write_date_pending", readyRowCount: 5 });
      expect(screen.getByText("Wait for the write date to finish updating.")).toBeInTheDocument();
    });
  });
});
