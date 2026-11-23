// PreviewSaveTabs — inner navigation strip for the Preview & save column.
//
// Slot-based: this composite owns the per-model tab strip and a body
// container; the host renders the actual grid mount (or anything else)
// for the active tab through `renderActiveBody`.
//
// Boundary: this composite knows the `PreviewModelTab` shape and the
// substrate vocabulary it carries (ready / needs-review / parse-error
// counts). It does NOT know app-specific labels — the host's
// `PreviewModelTab.label` drives all visible model names.
//
// Synthetic Issues tab: when any tab carries parse errors or rows needing
// review, this composite derives a synthetic "Issues" tab from the
// aggregate count so the host doesn't have to manage that synthetic state.
// Its id is exported as `PREVIEW_ERRORS_TAB_ID`; the leading underscores
// keep it from colliding with a `ModelId`. The literal label "Issues" is
// the one place this composite owns an English string — the host cannot
// supply it because the host doesn't own the synthetic tab.

import { useCallback, useRef } from "react";
import type { KeyboardEvent, ReactNode } from "react";

import { StatusPill, type StatusPillTone } from "@autograph/components";

import type { PreviewModelTab } from "../types";

import "./preview-save.css";

// Stable sentinel id for the synthesized Issues tab. Leading double-
// underscore makes it distinguishable from any `ModelId` the host might
// pass in. Hosts compare against this constant when their
// `renderActiveBody` decides whether to render an errors table or a
// model grid.
export const PREVIEW_ERRORS_TAB_ID = "__preview_errors__" as const;

export type PreviewSaveTabsProps = {
  tabs: readonly PreviewModelTab[];
  // Preview-level non-blocking notices. Counted into the synthetic Issues
  // tab so reviewers find them, but they never tint the tab danger/warning
  // on their own and never block Save.
  noticeCount?: number;
  // The host owns `activeTabId`; this composite is controlled. When
  // `activeTabId` matches `PREVIEW_ERRORS_TAB_ID`, the Issues tab body
  // is the one rendered through `renderActiveBody`.
  activeTabId: string;
  onActiveTabChange: (next: string) => void;
  // Slot: render the grid mount (or errors body) for the active tab.
  // Called exactly once per render with `activeTabId`.
  renderActiveBody: (tabId: string) => ReactNode;
  className?: string;
};

type StripEntry = {
  id: string;
  label: string;
  // Total row count to render alongside the label. For the synthetic
  // Issues tab this is the aggregate issue count.
  rowCount: number;
  statusTone: StatusPillTone;
  // Locked status copy. Per-tab precedence: parse-errors > needs-review
  // > ready, so a tab with both error and ready rows reads as danger
  // until the issues are resolved. The synthetic Issues tab uses danger
  // only when it includes source parse errors.
  statusLabel: string;
};

function deriveStripEntries(tabs: readonly PreviewModelTab[], noticeCount: number): StripEntry[] {
  const entries: StripEntry[] = tabs.map((tab) => {
    if (tab.parseErrorRowCount > 0) {
      return {
        id: tab.modelId,
        label: tab.label,
        rowCount: tab.rowCount,
        statusTone: "danger" as const,
        statusLabel: `${tab.parseErrorRowCount} issue${tab.parseErrorRowCount === 1 ? "" : "s"}`,
      };
    }
    if (tab.needsReviewRowCount > 0) {
      return {
        id: tab.modelId,
        label: tab.label,
        rowCount: tab.rowCount,
        statusTone: "warning" as const,
        statusLabel: `${tab.needsReviewRowCount} to review`,
      };
    }
    return {
      id: tab.modelId,
      label: tab.label,
      rowCount: tab.rowCount,
      statusTone: "success" as const,
      statusLabel: `${tab.readyRowCount} ready`,
    };
  });

  const totalBlockingIssues = tabs.reduce(
    (sum, tab) => sum + tab.parseErrorRowCount + tab.needsReviewRowCount,
    0,
  );
  const totalIssues = totalBlockingIssues + noticeCount;
  if (totalIssues > 0) {
    const totalParseErrors = tabs.reduce((sum, tab) => sum + tab.parseErrorRowCount, 0);
    entries.push({
      id: PREVIEW_ERRORS_TAB_ID,
      // Contextual label: when nothing blocking exists the tab hosts only
      // notices, and calling it "Issues" would overstate severity.
      label: totalBlockingIssues > 0 ? "Issues" : "Notices",
      rowCount: totalIssues,
      statusTone: totalParseErrors > 0 ? "danger" : totalBlockingIssues > 0 ? "warning" : "neutral",
      statusLabel:
        totalBlockingIssues > 0
          ? `${totalBlockingIssues} issue${totalBlockingIssues === 1 ? "" : "s"}${
              noticeCount > 0 ? ` + ${noticeCount} notice${noticeCount === 1 ? "" : "s"}` : ""
            }`
          : `${noticeCount} notice${noticeCount === 1 ? "" : "s"}`,
    });
  }
  return entries;
}

function classNames(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

export function PreviewSaveTabs(props: PreviewSaveTabsProps) {
  const {
    tabs,
    noticeCount = 0,
    activeTabId,
    onActiveTabChange,
    renderActiveBody,
    className,
  } = props;
  const entries = deriveStripEntries(tabs, noticeCount);
  // Refs to the rendered tab buttons, in render order. Used by the
  // arrow-key handler below so focus + activation move together per
  // WAI-ARIA tablist (automatic-activation pattern).
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const handleStripKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      // Arrow-key nav for the synthetic tablist. ArrowLeft / ArrowRight
      // cycle through the strip, wrapping at the ends; Home / End jump
      // to first / last. The active tab follows focus (automatic
      // activation) so screen readers announce the active body change
      // alongside the focus move. Tab still leaves the strip.
      const activeIndex = entries.findIndex((entry) => entry.id === activeTabId);
      if (activeIndex < 0 || entries.length === 0) return;
      let nextIndex: number | null = null;
      if (event.key === "ArrowRight") nextIndex = (activeIndex + 1) % entries.length;
      else if (event.key === "ArrowLeft")
        nextIndex = (activeIndex - 1 + entries.length) % entries.length;
      else if (event.key === "Home") nextIndex = 0;
      else if (event.key === "End") nextIndex = entries.length - 1;
      if (nextIndex == null) return;
      event.preventDefault();
      const target = entries[nextIndex];
      if (!target) return;
      onActiveTabChange(target.id);
      // Move focus on the next paint — `tabIndex` will be `0` on the new
      // active tab after rerender, so the focus call resolves to the
      // correct button reference.
      queueMicrotask(() => {
        tabRefs.current[nextIndex!]?.focus();
      });
    },
    [activeTabId, entries, onActiveTabChange],
  );

  return (
    <div className={classNames("preview-save-tabs", className)}>
      <div
        role="tablist"
        aria-label="Preview model tabs"
        className="preview-save-tabs__strip"
        onKeyDown={handleStripKeyDown}
      >
        {entries.map((entry, index) => {
          const isActive = entry.id === activeTabId;
          const panelId = `preview-save-panel-${entry.id}`;
          return (
            <button
              key={entry.id}
              ref={(el) => {
                tabRefs.current[index] = el;
              }}
              type="button"
              role="tab"
              id={`preview-save-tab-${entry.id}`}
              aria-selected={isActive}
              aria-controls={panelId}
              // Roving tabindex per WAI-ARIA tablist: only the active tab
              // sits in the natural tab order. Arrow-key nav is handled
              // by `handleStripKeyDown` on the tablist container.
              tabIndex={isActive ? 0 : -1}
              data-active={isActive ? "true" : "false"}
              data-tab-id={entry.id}
              className="preview-save-tabs__tab"
              onClick={() => {
                if (!isActive) onActiveTabChange(entry.id);
              }}
            >
              <span className="preview-save-tabs__tab-label">{entry.label}</span>
              <span className="preview-save-tabs__tab-rowcount">{entry.rowCount}</span>
              <StatusPill tone={entry.statusTone} label={entry.statusLabel} />
            </button>
          );
        })}
      </div>
      <div
        role="tabpanel"
        id={`preview-save-panel-${activeTabId}`}
        aria-labelledby={`preview-save-tab-${activeTabId}`}
        className="preview-save-tabs__body"
      >
        {renderActiveBody(activeTabId)}
      </div>
    </div>
  );
}
