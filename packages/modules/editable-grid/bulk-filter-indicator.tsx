// BulkFilterIndicator — yellow strip above the grid that surfaces when a
// `controller.activeBulkFilter` is set.
//
// Surfaces:
//   "Showing N of M positions · grouped as <name>"
//   Rename group popover (TextField + Save/Cancel)
//   Change date for group popover (DatePickerCalendar)
//   Revert all N button (drops every staged edit in the group)
//   Clear filter button (un-narrows the view)
//
// The component takes callbacks for every action so it can stay layer-clean
// (`@contracts` + `@autograph/components` + `@autograph/icons` only). Apps wire
// `controller.setBulkFilter(null)` to `onClear`, `controller.revertBulkGroup`
// to `onRevertAll`, `controller.setBulkGroupEffectiveDate` to `onChangeDate`,
// and their own page-local rename action to `onRename` (the bulk-group label
// store stays app-owned per the architecture review — labels are frontend-
// only annotations on a substrate-level group id, and that policy lives on
// the page).
//
// `recordNoun` defaults to "records" but apps pass the model's noun
// ("positions", "people") so the copy reads naturally. The module doesn't
// know what model is mounted, so this is a per-call decision.
//
// Layer rules: imports from `@contracts` + `@autograph/components` + `@autograph/icons`
// only. No app-generated clients or `apps/` paths.

import { useRef, useState } from "react";

import { BodyPortalPopover, Button, DatePickerCalendar, TextField } from "@autograph/components";
import { Close } from "@autograph/icons";

const CONTAINER_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "var(--space-2) var(--space-6)",
  background: "var(--color-bg-filter-indicator)",
  borderBottom: "1px solid var(--color-border-filter-indicator)",
  fontSize: "var(--text-caption)",
  color: "var(--color-text-filter-indicator)",
};

const BUTTON_STYLE: React.CSSProperties = {
  padding: "var(--space-0-5) var(--space-2)",
  border: "1px solid var(--color-border-filter-indicator-strong)",
  background: "var(--color-bg-surface)",
  color: "var(--color-text-filter-indicator-strong)",
  borderRadius: "var(--radius-xs)",
  fontSize: "var(--text-micro)",
  cursor: "pointer",
  fontFamily: "inherit",
};

const CLEAR_BUTTON_STYLE: React.CSSProperties = {
  ...BUTTON_STYLE,
  display: "inline-flex",
  alignItems: "center",
  gap: "var(--space-1)",
};

export type BulkFilterIndicatorProps = {
  // Count of rows the filter narrows the view to (typically derived from
  // the controller's `pendingChangesByRow` digest by walking entries whose
  // `bulkGroupId` matches the active filter id).
  rowCount: number;
  // Total rows in the unfiltered view (typically `records.length` from the
  // page's read hook). Read-only — only used for the "N of M" copy.
  totalRows: number;
  // Resolved human label for the active bulk group. Apps pass
  // `bulkGroupLabel(controller.activeBulkFilter)`.
  groupName: string;
  // Singular/plural noun for what each row represents in the host app's
  // vocabulary. Defaults to "records"; pass "positions"/"people"/etc. so
  // the copy reads naturally.
  recordNoun?: string;
  onRename: (nextName: string) => void;
  onChangeDate: (nextEffectiveDate: string) => void;
  onRevertAll: () => void;
  onClear: () => void;
};

export function BulkFilterIndicator(props: BulkFilterIndicatorProps) {
  const {
    rowCount,
    totalRows,
    groupName,
    recordNoun = "records",
    onRename,
    onChangeDate,
    onRevertAll,
    onClear,
  } = props;

  const renameTriggerRef = useRef<HTMLButtonElement | null>(null);
  const dateTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [renameOpen, setRenameOpen] = useState(false);
  const [dateOpen, setDateOpen] = useState(false);

  return (
    <div data-bulk-filter-indicator style={CONTAINER_STYLE}>
      <div>
        Showing{" "}
        <b style={{ color: "var(--color-text-filter-indicator-strong)" }}>
          {rowCount} of {totalRows} {recordNoun}
        </b>{" "}
        · grouped as{" "}
        <b style={{ color: "var(--color-text-filter-indicator-strong)" }}>“{groupName}”</b>
      </div>
      <div style={{ display: "flex", gap: "var(--space-2)" }}>
        <button
          ref={renameTriggerRef}
          type="button"
          style={BUTTON_STYLE}
          data-bulk-rename-trigger
          aria-haspopup="dialog"
          aria-expanded={renameOpen}
          onClick={() => {
            setDateOpen(false);
            setRenameOpen((current) => !current);
          }}
        >
          Rename group
        </button>
        <button
          ref={dateTriggerRef}
          type="button"
          style={BUTTON_STYLE}
          data-bulk-change-date-trigger
          aria-haspopup="dialog"
          aria-expanded={dateOpen}
          onClick={() => {
            setRenameOpen(false);
            setDateOpen((current) => !current);
          }}
        >
          Change date for group
        </button>
        <button type="button" style={BUTTON_STYLE} onClick={onRevertAll}>
          Revert all {rowCount}
        </button>
        <button type="button" style={CLEAR_BUTTON_STYLE} onClick={onClear}>
          <Close aria-hidden="true" className="h-[var(--size-icon-xs)] w-[var(--size-icon-xs)]" />
          Clear filter
        </button>
      </div>
      <BodyPortalPopover
        open={renameOpen}
        anchorRef={renameTriggerRef}
        ariaLabel="Rename bulk group"
        onClose={() => setRenameOpen(false)}
      >
        <RenameBulkGroupPopover
          initialValue={groupName}
          onCancel={() => setRenameOpen(false)}
          onSave={(next) => {
            onRename(next);
            setRenameOpen(false);
          }}
        />
      </BodyPortalPopover>
      <BodyPortalPopover
        open={dateOpen}
        anchorRef={dateTriggerRef}
        ariaLabel="Change effective date for bulk group"
        onClose={() => setDateOpen(false)}
      >
        <div
          data-bulk-change-date-popover
          style={{
            width: "var(--size-date-picker-popover)",
            height: "var(--size-date-picker-popover)",
          }}
        >
          <DatePickerCalendar
            value=""
            onSelect={(next) => {
              if (!next) return;
              onChangeDate(next);
              setDateOpen(false);
            }}
          />
        </div>
      </BodyPortalPopover>
    </div>
  );
}

// Rename popover body. Single TextField pre-filled with the current
// group name + Save / Cancel. Save fires `onSave(value)`; the parent
// closes the popover after it lands the rename. Save is disabled when
// the value is empty (a blank label is functionally a delete and
// outside the rename's scope) or unchanged.
function RenameBulkGroupPopover(props: {
  initialValue: string;
  onSave: (next: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(props.initialValue);
  const trimmed = value.trim();
  const canSave = trimmed.length > 0 && trimmed !== props.initialValue;
  return (
    <form
      data-bulk-rename-popover
      onSubmit={(event) => {
        event.preventDefault();
        if (!canSave) return;
        props.onSave(trimmed);
      }}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-2)",
        padding: "var(--space-3)",
        minWidth: "var(--size-popover-min-width)",
      }}
    >
      <TextField
        aria-label="Bulk group name"
        autoFocus
        size="sm"
        value={value}
        onValueChange={setValue}
      />
      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          gap: "var(--space-2)",
        }}
      >
        <Button intent="secondary" size="sm" onClick={props.onCancel}>
          Cancel
        </Button>
        <Button intent="primary" size="sm" type="submit" disabled={!canSave}>
          Save
        </Button>
      </div>
    </form>
  );
}
