import { requireArray, requireObject, requireString } from "./spec";
import type { DataTableColumnSpec, DataTableSpec } from "./DataTable";

export function validateDataTableSpec(value: unknown): DataTableSpec {
  const object = requireObject(value, "data_table.config");
  rejectUnknownKeys(
    object,
    new Set(["columns", "rows", "ariaLabel", "emptyLabel", "density", "frame", "type", "id"]),
    "data_table.config",
  );
  const columns: DataTableColumnSpec[] = requireArray(
    object.columns,
    "data_table.columns",
    (item, index) => {
      const column = requireObject(item, `data_table.columns[${index}]`);
      rejectUnknownKeys(
        column,
        new Set(["id", "label", "align", "width"]),
        `data_table.columns[${index}]`,
      );
      if (
        column.align !== undefined &&
        column.align !== "left" &&
        column.align !== "right" &&
        column.align !== "center"
      ) {
        throw new Error(`data_table.columns[${index}].align is unsupported`);
      }
      return {
        id: requireString(column.id, `data_table.columns[${index}].id`),
        label: requireString(column.label, `data_table.columns[${index}].label`),
        align: column.align === "right" || column.align === "center" ? column.align : "left",
        width: typeof column.width === "string" ? column.width : undefined,
      };
    },
  );
  const columnIds = new Set<string>();
  for (const column of columns) {
    if (columnIds.has(column.id)) {
      throw new Error(`data_table.columns ids must be unique: ${column.id}`);
    }
    columnIds.add(column.id);
  }
  return {
    columns,
    rows: requireArray(object.rows, "data_table.rows", (item, index) => {
      const row = requireObject(item, `data_table.rows[${index}]`);
      return Object.fromEntries(
        Object.entries(row).map(([key, cell]) => {
          if (typeof cell === "number" && !Number.isFinite(cell)) {
            throw new Error(`data_table.rows[${index}].${key} must be a finite number`);
          }
          if (
            cell !== null &&
            typeof cell !== "string" &&
            typeof cell !== "number" &&
            typeof cell !== "boolean"
          ) {
            throw new Error(`data_table.rows[${index}].${key} must be serializable`);
          }
          return [key, cell];
        }),
      );
    }),
    ariaLabel: typeof object.ariaLabel === "string" ? object.ariaLabel : undefined,
    emptyLabel: typeof object.emptyLabel === "string" ? object.emptyLabel : "No rows.",
    density: object.density === "compact" ? "compact" : "regular",
    frame: object.frame === "flat" ? "flat" : "outlined",
  };
}

function rejectUnknownKeys(object: Record<string, unknown>, allowed: Set<string>, path: string) {
  const unknown = Object.keys(object).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`${path}.${unknown} is not supported`);
}
