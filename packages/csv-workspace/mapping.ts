import { inferCsvDelimiter, parseCsv } from "../engines/csv-parser/index";

/** Deterministic CSV entry, shared by the browser and MCP. Empty cells are omitted. */
export type MappedImportRow = { values: Record<string, unknown>; externalKey?: string };
export const externalKeyColumn = "$externalKey";
export const maxImportRows = 100;
export const maxImportBytes = 512 * 1024;

export function readImportCsv(csv: string) {
  if (typeof csv !== "string" || new TextEncoder().encode(csv).length > maxImportBytes)
    throw new Error("Choose a CSV file no larger than 512 KiB.");
  const parsed = parseCsv(csv, { delimiter: inferCsvDelimiter(csv), maxRows: maxImportRows + 1 });
  if (parsed.errors.length) throw new Error(parsed.errors.map((error) => error.message).join("; "));
  if (!parsed.rows.length || parsed.rows.length > maxImportRows)
    throw new Error("Import between 1 and 100 rows at a time.");
  if (parsed.renamedHeaders.length)
    throw new Error("CSV column headings must be unique. Rename duplicate headings first.");
  return parsed;
}

/** A source column maps to a public field name/id, or the kernel's external key. */
export function mapImportCsv(csv: string, mapping: Record<string, string>): MappedImportRow[] {
  const parsed = readImportCsv(csv);
  if (!mapping || typeof mapping !== "object" || Array.isArray(mapping))
    throw new Error("Choose a column mapping.");
  const targets = Object.entries(mapping).filter(([, target]) => target !== "");
  if (!targets.length) throw new Error("Map at least one column.");
  if (
    targets.some(
      ([source, target]) => !parsed.headers.includes(source) || typeof target !== "string",
    )
  )
    throw new Error("Unknown CSV column mapping.");
  if (new Set(targets.map(([, target]) => target)).size !== targets.length)
    throw new Error("Map each destination field only once.");
  const seen = new Set<string>();
  return parsed.rows.map((source, index) => {
    const row: MappedImportRow = { values: {} };
    for (const [column, target] of targets) {
      const value = source[column] ?? "";
      if (target === externalKeyColumn) {
        if (!value.trim()) throw new Error(`Row ${index + 2}: external key is empty.`);
        if (seen.has(value))
          throw new Error(`Row ${index + 2}: duplicate external key in this file.`);
        seen.add(value);
        row.externalKey = value;
      } else if (value !== "")
        Object.defineProperty(row.values, target, {
          value,
          enumerable: true,
          configurable: true,
          writable: true,
        });
    }
    return row;
  });
}
