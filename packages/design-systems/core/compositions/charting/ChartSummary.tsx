import type { ChartSegmentClick } from "./types";

export function ChartSummary(props: {
  caption: string;
  columns: string[];
  rows: Array<{ id: string; cells: string[]; segment?: ChartSegmentClick }>;
  onSegmentClick?: (segment: ChartSegmentClick) => void;
  actionLabel?: string;
  /** Shown to everyone, for a chart that cannot be drawn; otherwise screen readers only. */
  visible?: boolean;
}) {
  return (
    <div
      className={
        props.visible
          ? "max-h-[360px] overflow-auto text-[length:var(--text-caption)] text-[var(--color-text-secondary)]"
          : "sr-only"
      }
    >
      <table className={props.visible ? "w-full text-left" : undefined}>
        <caption>{props.caption}</caption>
        <thead>
          <tr>
            {props.columns.map((column) => (
              <th key={column} scope="col">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {props.rows.map((row) => (
            <tr key={row.id}>
              {row.cells.map((cell, index) => {
                const column = props.columns[index];
                return index === 0 ? (
                  <th key={`${row.id}:${column}`} scope="row">
                    {cell}
                  </th>
                ) : (
                  <td key={`${row.id}:${column}`}>{cell}</td>
                );
              })}
              {props.onSegmentClick && row.segment ? (
                <td>
                  <button type="button" onClick={() => props.onSegmentClick?.(row.segment!)}>
                    {props.actionLabel ?? "Inspect"} {row.cells[0]}
                  </button>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
