// FilterBar — segmented control (Drafts | Published) + type select.
//
// Author filter and other app-specific filters are NOT modeled here yet —
// keeps the module's surface narrow. Pages that need additional filter
// affordances can compose the surface inside their own toolbar; this
// component handles the tab + type select pair, which is the bit every
// review surface wants.

import { useMemo, type ReactNode } from "react";

import { SegmentedControl, Select } from "@autograph/components";
import type { ChangeType } from "@contracts";

export const ALL_TYPES = "__all__";

export type ReviewTab = "drafts" | "published" | "rejected";

const LABEL_STYLE: React.CSSProperties = {
  fontSize: "var(--text-caption)",
  color: "var(--color-text-muted)",
  display: "inline-flex",
  alignItems: "center",
  gap: "var(--space-2)",
};

export function FilterBar(props: {
  tab: ReviewTab;
  onTabChange: (next: ReviewTab) => void;
  // The Drafts tab's count; null hides the tab.
  draftsCount: number | null;
  publishedCount: number;
  // The Rejected tab's count; null hides the tab.
  rejectedCount?: number | null;
  typeFilter: string;
  onTypeFilterChange: (next: string) => void;
  changeTypes: ReadonlyArray<ChangeType>;
  // Optional app slot rendered to the right of the type select (e.g. an
  // "Author" select bound to local app state, or any per-app filter).
  extras?: ReactNode;
}): ReactNode {
  const typeOptions = useMemo(
    () => [
      { value: ALL_TYPES, label: "All types" },
      ...props.changeTypes.map((ct) => ({ value: ct.id, label: ct.label })),
    ],
    [props.changeTypes],
  );
  const rejectedCount = props.rejectedCount ?? null;
  const draftsCount = props.draftsCount;
  const tabOptions = useMemo<ReadonlyArray<{ value: ReviewTab; label: string }>>(
    () => [
      ...(draftsCount === null
        ? []
        : [{ value: "drafts" as const, label: `Drafts (${draftsCount})` }]),
      { value: "published", label: `Published (${props.publishedCount})` },
      ...(rejectedCount === null
        ? []
        : [{ value: "rejected" as const, label: `Rejected (${rejectedCount})` }]),
    ],
    [draftsCount, props.publishedCount, rejectedCount],
  );
  return (
    <div className="flex items-center gap-[var(--space-4)] flex-wrap">
      <SegmentedControl<ReviewTab>
        ariaLabel="Approval status"
        value={props.tab}
        onChange={props.onTabChange}
        options={tabOptions}
      />
      {/* No type filter when the app declares no change types. */}
      {props.changeTypes.length === 0 ? null : (
        <label style={LABEL_STYLE}>
          Type:
          <Select
            size="sm"
            className="w-auto"
            value={props.typeFilter}
            onValueChange={props.onTypeFilterChange}
            options={typeOptions}
          />
        </label>
      )}
      {props.extras}
    </div>
  );
}
