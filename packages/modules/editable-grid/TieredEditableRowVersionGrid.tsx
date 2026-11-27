import { useCallback, useEffect, useRef } from "react";
import { AgGridReact } from "ag-grid-react";
import type {
  CellClickedEvent,
  ColDef,
  GetRowIdParams,
  GridApi,
  GridReadyEvent,
} from "ag-grid-community";

import type { VisibleRecord } from "@contracts";

import { EditableRowVersionGrid } from "./EditableRowVersionGrid";
import { isAdvancedGridBootstrapped, isBasicGridBootstrapped } from "./grid-state";
import { isMetaRow } from "./row-meta-model";
import { RowMetaRowRenderer, type MetaRowMarker } from "./row-meta-row";
import { AgGridReadTheme, AgGridTheme } from "./theme";
import type { EditableRowVersionGridSurfaceProps } from "./types";

export type GridAnalyticsTier = "basic" | "advanced";

export type TieredEditableRowVersionGridProps = EditableRowVersionGridSurfaceProps & {
  analytics: GridAnalyticsTier;
};

const BASIC_DEFAULT_COL_DEF: ColDef<VisibleRecord> = {
  filter: true,
  sortable: true,
  resizable: true,
  enableRowGroup: false,
  minWidth: 120,
};

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

export function TieredEditableRowVersionGrid(props: TieredEditableRowVersionGridProps) {
  const { analytics, ...surfaceProps } = props;
  if (analytics !== "basic" && analytics !== "advanced") {
    throw new Error(
      "EditableRowVersionGrid requires an explicit analytics='basic' | 'advanced' prop.",
    );
  }
  if (analytics === "advanced" && !isAdvancedGridBootstrapped()) {
    throw new Error(
      "EditableRowVersionGrid with analytics='advanced' requires bootstrapAdvancedGrid() from '@arrusted/ui/grid-advanced' before rendering.",
    );
  }
  if (analytics === "basic" && !isBasicGridBootstrapped() && !isAdvancedGridBootstrapped()) {
    throw new Error(
      "EditableRowVersionGrid with analytics='basic' requires bootstrapBasicGrid() from '@arrusted/ui' (or '@arrusted/ui/grid-basic') before rendering.",
    );
  }

  const isEditMode = surfaceProps.mode === "edit";
  const gridApiRef = useRef<GridApi<VisibleRecord | MetaRowMarker> | null>(null);
  const onGridReady = useCallback(
    (event: GridReadyEvent<VisibleRecord | MetaRowMarker>) => {
      gridApiRef.current = event.api;
      surfaceProps.onGridReady(event);
    },
    [surfaceProps],
  );

  useEffect(() => {
    if (analytics !== "basic") return;
    gridApiRef.current?.onFilterChanged();
  }, [analytics, surfaceProps.filterVersion]);

  useEffect(() => {
    if (analytics !== "basic") return;
    const columns = surfaceProps.columnDefs
      .filter(
        (column) =>
          (column.cellEditorParams as { fieldType?: { type?: string } } | undefined)?.fieldType
            ?.type === "relation",
      )
      .flatMap((column) => (column.colId ? [column.colId] : []));
    if (columns.length > 0) gridApiRef.current?.refreshCells({ force: true, columns });
  }, [analytics, surfaceProps.columnDefs]);

  if (analytics === "advanced") {
    return <EditableRowVersionGrid {...surfaceProps} />;
  }

  const communityColumns = surfaceProps.columnDefs.map((col) => ({
    ...col,
    enableRowGroup: false,
    rowGroup: false,
    pivot: false,
    aggFunc: undefined,
  })) as ColDef<VisibleRecord | MetaRowMarker>[];

  return (
    <div
      data-grid="editable-row-version"
      data-grid-mode={surfaceProps.mode}
      data-grid-analytics="basic"
      className="h-full w-full"
    >
      <AgGridReact<VisibleRecord | MetaRowMarker>
        theme={isEditMode ? AgGridTheme : AgGridReadTheme}
        rowData={surfaceProps.rows}
        columnDefs={communityColumns}
        defaultColDef={BASIC_DEFAULT_COL_DEF}
        getRowId={(p: GetRowIdParams<VisibleRecord | MetaRowMarker>) => p.data.record_id}
        singleClickEdit={false}
        stopEditingWhenCellsLoseFocus
        animateRows={false}
        onGridReady={onGridReady}
        isFullWidthRow={surfaceProps.isFullWidthRow}
        fullWidthCellRenderer={RowMetaRowRenderer}
        fullWidthCellRendererParams={surfaceProps.fullWidthCellRendererParams}
        getRowHeight={surfaceProps.getRowHeight}
        isExternalFilterPresent={() => surfaceProps.externalFilterPresent}
        doesExternalFilterPass={surfaceProps.externalFilterPass}
        rowSelection={withDefaultIsRowSelectable(surfaceProps.rowSelection)}
        onSelectionChanged={surfaceProps.onSelectionChanged}
        onCellClicked={
          surfaceProps.onCellClicked
            ? (event: CellClickedEvent<VisibleRecord | MetaRowMarker>) => {
                const data = event.data;
                if (!data || isMetaRow(data)) return;
                const target = event.event?.target;
                if (target instanceof Element && target.closest(".ag-cell-pin")) return;
                const fieldId = event.column.getColId();
                if (!surfaceProps.columnDefs.some((column) => column.colId === fieldId)) return;
                surfaceProps.onCellClicked?.({ rowKey: data.record_id, fieldId });
              }
            : undefined
        }
      />
    </div>
  );
}
