import { useCallback, useEffect, useRef } from "react";
import { AgGridReact } from "ag-grid-react";
import type {
  CellClickedEvent,
  ColDef,
  GetRowIdParams,
  GridApi,
  GridReadyEvent,
  IRowNode,
} from "ag-grid-community";

import type { VisibleRecord } from "@contracts";

import { AgGridReadTheme, AgGridTheme } from "./theme";
import { isMetaRow } from "./row-meta-model";
import { RowMetaRowRenderer, type MetaRowMarker } from "./row-meta-row";
import type { EditableRowVersionGridSurfaceProps } from "./types";

import "./dirty-glyph.css";
import "./diff-cell.css";
import "./invalid-cell.css";
import "./cell-editor-mount.css";
import "./row-meta-row.css";
import "./header-chrome.css";

// Default AG Grid affordances; apps can override per column.
const DEFAULT_COL_DEF: ColDef<VisibleRecord> = {
  filter: true,
  sortable: true,
  resizable: true,
  enableRowGroup: true,
  minWidth: 120,
};

// Leave auto-group column undefined so AG Grid's default renderer preserves
// source-column valueFormatters. Count styling lives in header-chrome.css.

// Guard synthetic meta rows out of object-form multi-row selection by default.
function withDefaultIsRowSelectable(
  rowSelection: EditableRowVersionGridSurfaceProps["rowSelection"],
): EditableRowVersionGridSurfaceProps["rowSelection"] {
  if (rowSelection == null) return rowSelection;
  if (typeof rowSelection === "string") return rowSelection;
  if (rowSelection.isRowSelectable) return rowSelection;
  return {
    ...rowSelection,
    isRowSelectable: (node) => !isMetaRow(node.data),
  };
}

export function EditableRowVersionGrid(props: EditableRowVersionGridSurfaceProps) {
  const isEditMode = props.mode === "edit";

  // Local api mirror lets filterVersion force AG Grid external-filter refreshes.
  const gridApiRef = useRef<GridApi<VisibleRecord | MetaRowMarker> | null>(null);
  const onGridReady = useCallback(
    (event: GridReadyEvent<VisibleRecord | MetaRowMarker>) => {
      gridApiRef.current = event.api;
      props.onGridReady(event);
    },
    [props],
  );
  useEffect(() => {
    gridApiRef.current?.onFilterChanged();
  }, [props.filterVersion]);
  // New column definitions can carry new link labels (loaded after the rows,
  // or picked from search), which AG Grid does not re-run for unchanged values.
  useEffect(() => {
    const columns = props.columnDefs
      .filter(
        (column) =>
          (column.cellEditorParams as { fieldType?: { type?: string } } | undefined)?.fieldType
            ?.type === "relation",
      )
      .flatMap((column) => (column.colId ? [column.colId] : []));
    if (columns.length > 0) gridApiRef.current?.refreshCells({ force: true, columns });
  }, [props.columnDefs]);

  return (
    <div data-grid="editable-row-version" data-grid-mode={props.mode} className="h-full w-full">
      <AgGridReact<VisibleRecord | MetaRowMarker>
        theme={isEditMode ? AgGridTheme : AgGridReadTheme}
        rowData={props.rows}
        columnDefs={props.columnDefs as ColDef<VisibleRecord | MetaRowMarker>[]}
        defaultColDef={DEFAULT_COL_DEF}
        getRowId={(p: GetRowIdParams<VisibleRecord | MetaRowMarker>) => p.data.record_id}
        singleClickEdit={false}
        stopEditingWhenCellsLoseFocus
        animateRows={false}
        // Pivot controls stay hidden until the page wires pivot data.
        sideBar={{
          toolPanels: [
            {
              id: "columns",
              labelDefault: "Columns",
              labelKey: "columns",
              iconKey: "columns",
              toolPanel: "agColumnsToolPanel",
              toolPanelParams: {
                suppressPivotMode: true,
                suppressPivots: true,
                suppressRowGroups: false,
                suppressValues: false,
              },
            },
            {
              id: "filters",
              labelDefault: "Filters",
              labelKey: "filters",
              iconKey: "filter",
              toolPanel: "agFiltersToolPanel",
            },
          ],
        }}
        onGridReady={onGridReady}
        isFullWidthRow={props.isFullWidthRow}
        fullWidthCellRenderer={RowMetaRowRenderer}
        fullWidthCellRendererParams={props.fullWidthCellRendererParams}
        getRowHeight={props.getRowHeight}
        isExternalFilterPresent={() => props.externalFilterPresent}
        doesExternalFilterPass={props.externalFilterPass}
        cellSelection={isEditMode}
        rowSelection={withDefaultIsRowSelectable(props.rowSelection)}
        onSelectionChanged={props.onSelectionChanged}
        onCellClicked={
          props.onCellClicked
            ? (event: CellClickedEvent<VisibleRecord | MetaRowMarker>) => {
                const data = event.data;
                if (!data || isMetaRow(data)) return;
                // A host pin inside the cell is its own control, not a cell click.
                const target = event.event?.target;
                if (target instanceof Element && target.closest(".ag-cell-pin")) return;
                // Grid-made columns (row grouping's auto column) are not fields.
                const fieldId = event.column.getColId();
                if (!props.columnDefs.some((column) => column.colId === fieldId)) return;
                props.onCellClicked?.({ rowKey: data.record_id, fieldId });
              }
            : undefined
        }
      />
    </div>
  );
}
