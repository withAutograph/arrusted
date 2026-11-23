import { Badge } from "../components/Display";
import { cx, focusRing } from "../components/utils";
import type { CompositionSpec } from "./spec";

export type SerializableCellValue = string | number | boolean | null;

export type DataTableColumnSpec = {
  id: string;
  label: string;
  align?: "left" | "right" | "center";
  width?: string;
};

export type DataTableSpec = {
  columns: DataTableColumnSpec[];
  rows: Array<Record<string, SerializableCellValue>>;
  ariaLabel?: string;
  emptyLabel?: string;
  density?: "compact" | "regular";
  frame?: "outlined" | "flat";
};

export function DataTableComposition(props: {
  spec: CompositionSpec<"data_table", DataTableSpec>;
  /** Returns the stable, unique identity for each selectable row. */
  getRowId?: (row: Record<string, SerializableCellValue>) => string;
  selectedRowId?: string;
  onRowSelect?: (rowId: string, row: Record<string, SerializableCellValue>) => void;
  selectionLabel?: string;
}) {
  const {
    columns,
    rows,
    emptyLabel = "No rows.",
    density = "regular",
    frame = "outlined",
  } = props.spec.config;
  const selectable = Boolean(props.getRowId && props.onRowSelect);
  const rowsWithKeys = keyedRows(rows, columns);
  if (rows.length === 0) {
    return (
      <div className="rounded-[var(--radius-panel)] border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] p-[var(--space-6)] text-center text-[length:var(--text-body)] text-[var(--color-text-muted)]">
        {emptyLabel}
      </div>
    );
  }
  return (
    <div
      className={`max-w-full overflow-x-auto rounded-[var(--radius-control)] bg-[var(--color-bg-surface)] ${
        frame === "outlined" ? "border border-[var(--color-border-subtle)]" : "border-0"
      }`}
      data-frame={frame}
    >
      <table
        aria-label={props.spec.config.ariaLabel}
        className="w-full min-w-max border-collapse text-left text-[length:var(--text-body)]"
      >
        <thead className="bg-[var(--color-bg-subtle)] text-[length:var(--text-caption)] font-[var(--font-weight-semibold)] uppercase tracking-[var(--tracking-label)] text-[var(--color-text-muted)]">
          <tr>
            {selectable ? (
              <th scope="col" className="px-[var(--space-3)] py-[var(--space-2)]">
                {props.selectionLabel ?? "Select record"}
              </th>
            ) : null}
            {columns.map((column) => (
              <th
                key={column.id}
                scope="col"
                style={{ width: column.width, textAlign: column.align }}
                className="border-b border-[var(--color-border-subtle)] px-[var(--space-3)] py-[var(--space-2)]"
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rowsWithKeys.map(({ key, row }, index) => (
            <tr
              key={key}
              data-selected={
                selectable && props.selectedRowId === props.getRowId?.(row) ? "true" : undefined
              }
              className="border-b border-[var(--color-border-subtle)] last:border-0 data-[selected=true]:bg-[var(--color-bg-selected)]"
            >
              {selectable ? (
                <td className="px-[var(--space-3)] py-[var(--space-2)]">
                  <button
                    type="button"
                    data-record-selection="true"
                    aria-pressed={props.selectedRowId === props.getRowId?.(row)}
                    aria-label={`${props.selectionLabel ?? "Select record"}: ${String(row[columns[0]?.id ?? ""] ?? index + 1)}`}
                    className={cx(
                      "rounded-[var(--radius-control)] text-[var(--color-action-primary-ink)]",
                      focusRing,
                    )}
                    onClick={() => props.onRowSelect?.(props.getRowId!(row), row)}
                    onKeyDown={(event) => {
                      const offset =
                        event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
                      if (!offset && event.key !== "Home" && event.key !== "End") return;
                      event.preventDefault();
                      const buttons = event.currentTarget
                        .closest("table")
                        ?.querySelectorAll<HTMLButtonElement>("button[data-record-selection]");
                      const next =
                        event.key === "Home"
                          ? 0
                          : event.key === "End"
                            ? rows.length - 1
                            : Math.max(0, Math.min(rows.length - 1, index + offset));
                      buttons?.[next]?.focus();
                    }}
                  >
                    {props.selectedRowId === props.getRowId?.(row) ? "Selected" : "Select"}
                  </button>
                </td>
              ) : null}
              {columns.map((column) => (
                <td
                  key={column.id}
                  className={
                    density === "compact"
                      ? "px-[var(--space-3)] py-[var(--space-1-5)]"
                      : "px-[var(--space-3)] py-[var(--space-2-5)]"
                  }
                  style={{ textAlign: column.align }}
                >
                  {renderCell(row[column.id])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function renderCell(value: SerializableCellValue | undefined) {
  if (value === null || value === undefined || value === "") {
    return <span className="text-[var(--color-text-disabled)]">-</span>;
  }
  if (typeof value === "boolean") {
    return <Badge tone={value ? "success" : "neutral"}>{value ? "Yes" : "No"}</Badge>;
  }
  return value;
}

function keyedRows(
  rows: readonly Record<string, SerializableCellValue>[],
  columns: readonly DataTableColumnSpec[],
): Array<{ key: string; row: Record<string, SerializableCellValue> }> {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    const baseKey = rowContentKey(row, columns);
    const count = seen.get(baseKey) ?? 0;
    seen.set(baseKey, count + 1);
    return { key: `${baseKey}:${count}`, row };
  });
}

function rowContentKey(
  row: Record<string, SerializableCellValue>,
  columns: readonly DataTableColumnSpec[],
) {
  return JSON.stringify(columns.map((column) => [column.id, row[column.id] ?? ""] as const));
}
