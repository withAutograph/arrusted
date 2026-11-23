export type CsvParseOptions = {
  delimiter?: string;
  maxRows?: number;
};

export type CsvParseIssue = {
  row: number;
  code: string;
  message: string;
};

// Non-blocking parse warning: something the parser repaired or normalized on
// the caller's behalf (e.g. a renamed duplicate header). Structurally
// separate from `errors` — warnings never invalidate the parse.
export type CsvParseWarning = {
  row: number;
  code: string;
  message: string;
};

export type CsvHeaderRename = {
  original: string;
  renamed: string;
};

export type CsvParsedRow = {
  rowNumber: number;
  values: Record<string, string>;
};

export type CsvParseResult = {
  headers: string[];
  rows: Array<Record<string, string>>;
  parsedRows: CsvParsedRow[];
  errors: CsvParseIssue[];
  warnings: CsvParseWarning[];
  // Duplicate headers auto-renamed (original -> renamed), in header order.
  renamedHeaders: CsvHeaderRename[];
};

export type CsvProfileOptions = {
  sampleRowLimit?: number;
  sampleValueLimit?: number;
};

export type CsvSampleCell = {
  column: string;
  value: string;
};

export type CsvSampleRow = {
  rowNumber: number;
  cells: CsvSampleCell[];
};

export type CsvColumnProfile = {
  column: string;
  sampleValues: string[];
  nonEmptyCount: number;
  emptyCount: number;
};

export type CsvProfile = {
  rowCount: number;
  columnCount: number;
  headers: string[];
  parseIssueCount: number;
  sampleRows: CsvSampleRow[];
  columns: CsvColumnProfile[];
};

export const CSV_DELIMITER_CANDIDATES = [",", "\t", ";", "|"] as const;

export type CsvDelimiterCandidate = (typeof CSV_DELIMITER_CANDIDATES)[number];

export function inferCsvDelimiter(
  input: string,
  options: { maxRows?: number } = {},
): CsvDelimiterCandidate {
  const scored = CSV_DELIMITER_CANDIDATES.map((delimiter) => {
    const parsed = parseCsv(input, { delimiter, maxRows: options.maxRows });
    const profile = profileCsvParseResult(parsed);
    const malformedCandidatePenalty =
      parsed.errors.length > 0 && profile.rowCount === 0 ? 100_000 : 0;
    const singleColumnPenalty = parsed.errors.length === 0 && profile.columnCount <= 1 ? 5_000 : 0;
    return {
      delimiter,
      score:
        malformedCandidatePenalty +
        singleColumnPenalty +
        parsed.errors.length * 1_000 -
        profile.columnCount * 20 -
        profile.rowCount,
    };
  });
  scored.sort((left, right) => left.score - right.score);
  return scored[0]?.delimiter ?? ",";
}

export function parseCsv(input: string, options: CsvParseOptions = {}): CsvParseResult {
  const delimiter = options.delimiter ?? ",";
  // Normalize ONCE, up front: BOM strip + CRLF/CR -> LF. Every row number
  // reported below (encoding errors included) is counted on this normalized
  // text — counting on raw input miscounts CR-only (classic Mac) files.
  const normalized = normalizeCsvText(input);
  // Invalid bytes surface as U+FFFD replacement characters after decode; a
  // file containing them was almost certainly saved in a non-UTF-8 encoding.
  // Fail loud with actionable copy instead of importing mojibake.
  const replacementIndex = normalized.indexOf("\uFFFD");
  if (replacementIndex !== -1) {
    let row = 1;
    for (let index = 0; index < replacementIndex; index += 1)
      if (normalized[index] === "\n") row += 1;
    return {
      headers: [],
      rows: [],
      parsedRows: [],
      errors: [
        {
          row,
          code: "invalid_encoding",
          message:
            "The file contains characters that are not valid UTF-8. Save the file as UTF-8 (CSV UTF-8 in Excel) and try again.",
        },
      ],
      warnings: [],
      renamedHeaders: [],
    };
  }
  const errors: CsvParseResult["errors"] = [];
  const records = parseCsvRecords(normalized, delimiter, errors);
  const headerRecord = records.next();
  const rawHeaders = (headerRecord.done ? [] : headerRecord.value.cells).map((header) =>
    header.trim(),
  );
  const rows: CsvParseResult["rows"] = [];
  const parsedRows: CsvParsedRow[] = [];
  const maxRows = options.maxRows ?? 10_000;

  if (rawHeaders.length === 0 || rawHeaders.every((header) => header.length === 0)) {
    return {
      headers: [],
      rows: [],
      parsedRows: [],
      errors: [{ row: 1, code: "missing_header", message: "CSV header is empty." }],
      warnings: [],
      renamedHeaders: [],
    };
  }
  const resolved = resolveHeaders(rawHeaders);
  const headers = resolved.headers;
  if (resolved.errors.length > 0) {
    return {
      headers,
      rows: [],
      parsedRows: [],
      errors: resolved.errors,
      warnings: resolved.warnings,
      renamedHeaders: resolved.renamedHeaders,
    };
  }

  let examinedRows = 0;
  for (const record of records) {
    if (record.cells.every((cell) => cell.trim().length === 0)) continue;
    // Bound parsed records and diagnostics, including malformed rows. The scanner
    // yields lazily so the rest of an oversized file is never materialized.
    if (examinedRows >= maxRows) {
      errors.push({
        row: record.rowNumber,
        code: "row_limit_exceeded",
        message: `CSV exceeds the ${maxRows.toLocaleString()} row limit.`,
      });
      break;
    }
    examinedRows += 1;
    const cells = record.cells;
    if (cells.length !== headers.length) {
      errors.push({
        row: record.rowNumber,
        code: "column_count_mismatch",
        message: `Expected ${headers.length} cells, found ${cells.length}.`,
      });
      continue;
    }
    const values = Object.fromEntries(
      headers.map((header, cellIndex) => [header, cells[cellIndex] ?? ""]),
    );
    rows.push(values);
    parsedRows.push({ rowNumber: record.rowNumber, values });
  }

  return {
    headers,
    rows,
    parsedRows,
    errors,
    warnings: resolved.warnings,
    renamedHeaders: resolved.renamedHeaders,
  };
}

// Blank headers stay blocking (a blank column cannot be referenced).
// Duplicate headers are repaired: each repeat gets a `_1` suffix (repeated
// until unique, case-insensitively) plus a non-blocking warning, so one
// sloppy export column no longer rejects the whole file.
function resolveHeaders(rawHeaders: readonly string[]): {
  headers: string[];
  errors: CsvParseIssue[];
  warnings: CsvParseWarning[];
  renamedHeaders: CsvHeaderRename[];
} {
  const errors: CsvParseIssue[] = [];
  const warnings: CsvParseWarning[] = [];
  const renamedHeaders: CsvHeaderRename[] = [];
  const headers: string[] = [];
  const originalHeaderCounts = new Map<string, number>();
  for (const header of rawHeaders) {
    if (header.length === 0) continue;
    const key = header.toLowerCase();
    originalHeaderCounts.set(key, (originalHeaderCounts.get(key) ?? 0) + 1);
  }
  const originalHeaders = new Set(originalHeaderCounts.keys());
  const usedHeaders = new Set<string>();
  const processedOriginalHeaders = new Map<string, number>();
  for (const [index, header] of rawHeaders.entries()) {
    if (header.length === 0) {
      errors.push({
        row: 1,
        code: "blank_header",
        message: `CSV header ${index + 1} is blank.`,
      });
      headers.push(header);
      continue;
    }
    const originalKey = header.toLowerCase();
    const processedCount = processedOriginalHeaders.get(originalKey) ?? 0;
    processedOriginalHeaders.set(originalKey, processedCount + 1);
    let resolved = header;
    if ((originalHeaderCounts.get(originalKey) ?? 0) > 1 && processedCount > 0) {
      resolved = `${resolved}_1`;
      while (
        usedHeaders.has(resolved.toLowerCase()) ||
        originalHeaders.has(resolved.toLowerCase())
      ) {
        resolved = `${resolved}_1`;
      }
    }
    if (resolved !== header) {
      renamedHeaders.push({ original: header, renamed: resolved });
      warnings.push({
        row: 1,
        code: "duplicate_header_renamed",
        message: `CSV header "${header}" conflicts with an existing header after duplicate-header normalization; it was renamed to "${resolved}".`,
      });
    }
    usedHeaders.add(resolved.toLowerCase());
    headers.push(resolved);
  }
  return { headers, errors, warnings, renamedHeaders };
}

export function profileCsvParseResult(
  result: CsvParseResult,
  options: CsvProfileOptions = {},
): CsvProfile {
  const sampleRowLimit = normalizeLimit(options.sampleRowLimit, 6);
  const sampleValueLimit = normalizeLimit(options.sampleValueLimit, 6);
  const columnProfiles = result.headers.map((column): CsvColumnProfile => {
    const sampleValues: string[] = [];
    const sampleValueSet = new Set<string>();
    let nonEmptyCount = 0;
    let emptyCount = 0;

    for (const row of result.rows) {
      const value = row[column] ?? "";
      if (value.trim().length === 0) {
        emptyCount += 1;
        continue;
      }
      nonEmptyCount += 1;
      if (sampleValues.length < sampleValueLimit && !sampleValueSet.has(value)) {
        sampleValueSet.add(value);
        sampleValues.push(value);
      }
    }

    return { column, sampleValues, nonEmptyCount, emptyCount };
  });

  return {
    rowCount: result.rows.length,
    columnCount: result.headers.length,
    headers: [...result.headers],
    parseIssueCount: result.errors.length,
    sampleRows: result.parsedRows.slice(0, sampleRowLimit).map((row) => ({
      rowNumber: row.rowNumber,
      cells: result.headers.map((column) => ({
        column,
        value: row.values[column] ?? "",
      })),
    })),
    columns: columnProfiles,
  };
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

type CsvRecord = {
  rowNumber: number;
  cells: string[];
};

function normalizeCsvText(input: string): string {
  return input
    .replace(/^\uFEFF/, "")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n");
}

function* parseCsvRecords(
  input: string,
  delimiter: string,
  errors: CsvParseIssue[],
): Generator<CsvRecord> {
  const normalized = input;
  let cells: string[] = [];
  let current = "";
  let quoted = false;
  let lineNumber = 1;
  let rowNumber = 1;

  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (character === '"') {
      if (quoted && normalized[index + 1] === '"') {
        current += '"';
        index += 1;
      } else if (quoted) {
        quoted = false;
      } else if (current.length === 0 || current.trim().length === 0) {
        current = "";
        quoted = true;
      } else {
        current += '"';
      }
      continue;
    }
    if (!quoted && character === delimiter) {
      cells.push(current);
      current = "";
      continue;
    }
    if (character === "\n") {
      if (quoted) {
        current += "\n";
        lineNumber += 1;
        continue;
      }
      cells.push(current);
      yield { rowNumber, cells };
      cells = [];
      current = "";
      lineNumber += 1;
      rowNumber = lineNumber;
      continue;
    }
    current += character;
  }

  if (quoted) {
    errors.push({
      row: rowNumber,
      code: "unterminated_quote",
      message: "CSV quoted value is missing a closing quote.",
    });
  }
  cells.push(current);
  if (!(cells.length === 1 && cells[0] === "" && normalized.endsWith("\n"))) {
    yield { rowNumber, cells };
  }
}
