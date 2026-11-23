// BulkUpdateTrigger — toolbar segment that pairs with `controller.stageBulkUpdate`.
//
// Surfaces:
//   "<N> selected" hint
//   "Clear" link (calls `onClearSelection`)
//   "Bulk update ▾" primary button with an inline DropdownMenu of
//   change-type picker items
//
// The trigger OWNS its own open/close state + outside-click + Escape + derived
// close-on-selection-clear behavior. Apps don't pass an `open` prop —
// they just hand in `selectedCount`, `items`, and callbacks. This bundles the
// dismiss footguns that used to live in the page (`bulkMenuOpen` state, the
// pointerdown listener, and the "selectedRecordIds.length === 0" close logic)
// into the component itself.
//
// `items` uses a STRUCTURAL shape (`BulkUpdatePickerItem`) so the module
// doesn't have to import HC's generated `ChangeType` — the boundary scanner
// would reject that import. Apps resolve the picked id back to their schema
// type at the call site (`schema.change_types.find((ct) => ct.id === id)`).
//
// Layer rules: this file lives in `packages/modules/editable-grid/` and may
// import from `@contracts` + `@autograph/components` + `@autograph/icons` only. It must
// NOT import from an app-generated client or any `apps/` path.

import { useCallback, useEffect, useRef, useState } from "react";

import { DropdownMenu } from "@autograph/components";
import { ChevronDown, ChevronUp } from "@autograph/icons";
import type { ChangeTypeId } from "@contracts";

// Schema-derived options the dropdown surfaces. App pulls these from its
// own schema (`schema.change_types.filter(ct => ct.target_model === ...)`)
// — the module stays schema-agnostic.
export type BulkUpdatePickerItem = {
  // The change_type's stable id; passed back to `onPick` so the app can
  // resolve to its richer schema type for the bulk-update sheet.
  id: ChangeTypeId;
  // The change_type's user-facing label (`schema.ChangeType.label`).
  label: string;
  // Pre-resolved "Field A · Field B · Field C" hint that reads beneath the
  // label in the menu. The app composes this from the change_type's
  // `touches` field-id array against its model's per-field labels — the
  // module doesn't have schema visibility to do this itself.
  touchLabels: string;
};

export type BulkUpdateTriggerProps = {
  // Live count of selected rows. The trigger hides itself when 0 — apps
  // typically also avoid rendering when 0, but the internal guard is here
  // so the dropdown can't fire `onPick` against an empty selection in an
  // edge case where the parent's gating render lags behind state.
  selectedCount: number;
  // The schema-derived change-type options the dropdown surfaces.
  items: ReadonlyArray<BulkUpdatePickerItem>;
  // Called when the user picks a change_type. The trigger closes the menu
  // itself before invoking — the app's handler just opens the bulk-update
  // sheet (or whatever follow-up surface).
  onPick: (id: ChangeTypeId) => void;
  // Called when the user clicks "Clear" to drop the selection. The grid
  // owns the selection state; this callback typically invokes the
  // `clearSelection()` returned by `useSelectedRowIds()`.
  onClearSelection: () => void;
  // Disabled in `mode === "read"` — the trigger paints as inert and the
  // menu won't open. The "<N> selected" hint stays visible so the user
  // can still see what's selected.
  disabled?: boolean;
};

export function BulkUpdateTrigger(props: BulkUpdateTriggerProps) {
  const { selectedCount, items, onPick, onClearSelection, disabled = false } = props;

  // OWN the open/close state + the four dismiss footguns (outside click,
  // Escape, selection clear, picked item). Apps don't see these — the
  // trigger's only props are functional inputs, not UI plumbing.
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [openRequest, setOpenRequest] = useState(false);
  const open = selectedCount > 0 && openRequest;

  useEffect(() => {
    if (selectedCount === 0) setOpenRequest(false);
  }, [selectedCount]);

  // Outside-click + Escape dismissal. The inline `Popover` is display-only
  // (it doesn't manage its own dismiss); the module owns the wiring so apps
  // don't have to re-implement it per page.
  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: PointerEvent) {
      const target = event.target;
      if (target instanceof Node && hostRef.current?.contains(target)) return;
      setOpenRequest(false);
    }
    function handleKey(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") setOpenRequest(false);
    }
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  const handleToggle = useCallback(() => {
    if (disabled) return;
    setOpenRequest((current) => !current);
  }, [disabled]);

  const handlePick = useCallback(
    (id: ChangeTypeId) => {
      setOpenRequest(false);
      onPick(id);
    },
    [onPick],
  );

  const triggerStyle: React.CSSProperties = {
    background: "var(--color-action-primary)",
    color: "var(--color-text-inverse)",
    borderColor: "var(--color-action-primary)",
    borderWidth: "1px",
    borderStyle: "solid",
    borderRadius: "var(--radius-control)",
    padding: "var(--space-1-5) var(--space-3)",
    fontWeight: "var(--font-weight-medium)",
    fontSize: "var(--text-caption)",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.5 : 1,
    fontFamily: "inherit",
  };

  return (
    <div
      ref={hostRef}
      data-bulk-update-trigger-host
      className="flex items-center gap-[var(--space-2)]"
    >
      <span
        data-bulk-selection-count
        className="text-[length:var(--text-caption)] text-[var(--color-text-secondary)]"
      >
        {selectedCount} selected
      </span>
      <button
        type="button"
        data-bulk-clear-selection
        className="text-[length:var(--text-caption)] text-[var(--color-text-secondary)] underline"
        onClick={onClearSelection}
      >
        Clear
      </button>
      <DropdownMenu
        open={open}
        trigger={
          <button
            type="button"
            data-bulk-update-trigger
            data-state={open ? "open" : "closed"}
            style={{
              ...triggerStyle,
              display: "inline-flex",
              alignItems: "center",
              gap: "var(--space-1)",
            }}
            disabled={disabled}
            onClick={handleToggle}
            aria-haspopup="menu"
            aria-expanded={open}
          >
            Bulk update
            {open ? (
              <ChevronUp
                aria-hidden="true"
                className="h-[var(--size-icon-xs)] w-[var(--size-icon-xs)]"
              />
            ) : (
              <ChevronDown
                aria-hidden="true"
                className="h-[var(--size-icon-xs)] w-[var(--size-icon-xs)]"
              />
            )}
          </button>
        }
        items={items.map((item) => ({
          id: item.id,
          label: (
            // Stacked label + quiet metadata: the change-type label leads,
            // touched-field summary reads as a quiet sub-line beneath. The
            // prior horizontal layout produced jagged wrap text once
            // touch summaries got long; stacked gives the metadata a
            // single predictable column width and keeps the menu items
            // visually aligned.
            <span className="flex flex-col gap-[var(--space-0-5)]">
              <span>{item.label}</span>
              <span className="text-[length:var(--text-caption)] text-[var(--color-text-muted)]">
                {item.touchLabels}
              </span>
            </span>
          ),
          onSelect: () => handlePick(item.id),
        }))}
      />
    </div>
  );
}
