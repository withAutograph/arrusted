// useSelectedRowIds — bridge between AG Grid's selection events and the
// app's bulk-action chrome.
//
// The editable-grid surface (`<EditableRowVersionGrid>`) accepts a
// `rowSelection` config + an `onSelectionChanged` callback. AG Grid is the
// authoritative source of "which rows are selected" (the api owns the
// highlight + checkbox UI); this hook mirrors a SLICE of that — the
// `record_id`s — into React state so the page's bulk-action chrome
// (BulkUpdateTrigger, etc.) can render off it without mirroring the full
// row data (mirroring full rows invites drift).
//
// The hook also exposes a `clearSelection()` that calls `deselectAll()` on
// the grid api the most recent event handed us, so apps don't have to keep
// their own ref to the AG Grid api just to drop the selection.
//
// Returned `onSelectionChanged` is shaped to match
// `EditableRowVersionGridSurfaceProps.onSelectionChanged` exactly so wiring
// is a one-liner:
//   const { onSelectionChanged, selectedRecordIds, clearSelection } =
//     useSelectedRowIds();
//   <EditableRowVersionGrid {...surfaceProps} onSelectionChanged={onSelectionChanged} />
//
// Meta rows (`record_id` starts with `meta:`) are filtered out — the
// `rowSelection.isRowSelectable` guard on the surface already prevents them
// from getting selected, but the filter here is a belt-and-suspenders so a
// future config flip can't sneak synthetic ids into bulk-action targets.

import { useCallback, useRef, useState } from "react";

import type { GridApi, SelectionChangedEvent } from "ag-grid-community";

import type { VisibleRecord } from "@contracts";

import type { MetaRowMarker } from "../row-meta-row";

export type UseSelectedRowIdsResult = {
  selectedRecordIds: string[];
  // Drop every selected row from AG Grid AND clear local state in one shot.
  // No-op before the first `onSelectionChanged` event (no api captured yet).
  clearSelection: () => void;
  // Wire this through to `<EditableRowVersionGrid>`'s `onSelectionChanged`.
  // The library typing matches the surface prop's typing exactly.
  onSelectionChanged: (event: SelectionChangedEvent<VisibleRecord | MetaRowMarker>) => void;
};

export function useSelectedRowIds(): UseSelectedRowIdsResult {
  const [selectedRecordIds, setSelectedRecordIds] = useState<string[]>([]);
  // Captures the most-recent AG Grid api so `clearSelection()` can call
  // `deselectAll()` without the caller having to keep their own ref. A ref
  // (not state) keeps the api binding from churning component renders.
  const gridApiRef = useRef<GridApi<VisibleRecord | MetaRowMarker> | null>(null);

  const onSelectionChanged = useCallback(
    (event: SelectionChangedEvent<VisibleRecord | MetaRowMarker>) => {
      gridApiRef.current = event.api;
      const rows = event.api.getSelectedRows();
      const ids: string[] = [];
      for (const row of rows) {
        // Filter synthetic meta rows out of the bulk-action target set —
        // `isRowSelectable` on the surface already prevents this in
        // practice, but the filter keeps the hook resilient if a caller
        // omits that guard.
        const candidate = (row as { record_id?: unknown }).record_id;
        if (typeof candidate === "string" && !candidate.startsWith("meta:")) {
          ids.push(candidate);
        }
      }
      setSelectedRecordIds(ids);
    },
    [],
  );

  const clearSelection = useCallback(() => {
    gridApiRef.current?.deselectAll();
    setSelectedRecordIds([]);
  }, []);

  return { selectedRecordIds, clearSelection, onSelectionChanged };
}
