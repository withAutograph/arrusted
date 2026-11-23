import { inferCsvDelimiter, parseCsv, profileCsvParseResult } from "../index";

import nodeAssert from "node:assert/strict";
import { describe, it } from "vite-plus/test";

function assert(condition: unknown, message: string): asserts condition {
  nodeAssert(condition, message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  nodeAssert.equal(actual, expected, message);
}

function testCsvParserEngine() {
  const parsed = parseCsv(
    [
      "employee_id,employee_name,location",
      "E-100,Ada Lovelace,SF",
      "",
      "E-101,Grace Hopper,San Francisco",
      "bad,row",
      "E-102,Ada Lovelace,SF",
    ].join("\n"),
  );

  assertEqual(parsed.headers.length, 3, "csv parser preserves header count");
  assertEqual(parsed.rows.length, 3, "csv parser skips blank and invalid data rows");
  assertEqual(
    parsed.parsedRows[0]?.rowNumber,
    2,
    "csv parser stores source row number for first row",
  );
  assertEqual(
    parsed.parsedRows[1]?.rowNumber,
    4,
    "csv parser preserves row number across blank lines",
  );
  assertEqual(
    parsed.parsedRows[1]?.values.employee_name,
    "Grace Hopper",
    "parsedRows mirror row values",
  );
  assertEqual(parsed.errors.length, 1, "csv parser records column-count parse issues");
  assertEqual(parsed.errors[0]?.row, 5, "csv parser reports parse issue source row number");

  const duplicateHeader = parseCsv("ID,id\nfirst,second");
  assertEqual(
    duplicateHeader.rows.length,
    1,
    "csv parser keeps rows when duplicate headers are auto-renamed",
  );
  assertEqual(duplicateHeader.errors.length, 0, "csv parser does not reject duplicate headers");
  assertEqual(
    duplicateHeader.headers.join(","),
    "ID,id_1",
    "csv parser renames the repeated header with a _1 suffix",
  );
  assertEqual(
    duplicateHeader.rows[0]?.["id_1"],
    "second",
    "renamed header carries the repeat column's values",
  );
  assertEqual(
    duplicateHeader.warnings[0]?.code,
    "duplicate_header_renamed",
    "csv parser emits a non-blocking rename warning",
  );
  assertEqual(
    duplicateHeader.renamedHeaders[0]?.renamed,
    "id_1",
    "csv parser records the rename mapping",
  );

  const cascadingDuplicates = parseCsv("Name,name,NAME_1\na,b,c");
  assertEqual(
    cascadingDuplicates.headers.join(","),
    "Name,name_1_1,NAME_1",
    "csv parser renames duplicates without trampling later original headers",
  );
  assertEqual(cascadingDuplicates.warnings.length, 1, "csv parser warns once per renamed header");
  assert(
    cascadingDuplicates.warnings[0]?.message.includes("conflicts with an existing header"),
    "csv parser describes cascade renames as header collisions, not literal duplicate counts",
  );

  // Row numbers for encoding errors count on NORMALIZED text: a CRLF file
  // and a CR-only (classic Mac) file must report the same line as an LF file.
  const invalidEncodingCrlf = parseCsv("name,city\r\nJos\uFFFD,Madrid");
  assertEqual(
    invalidEncodingCrlf.errors[0]?.row,
    2,
    "encoding-error row numbers are CRLF-normalization-consistent",
  );
  const invalidEncodingCrOnly = parseCsv("name,city\rJos\uFFFD,Madrid");
  assertEqual(
    invalidEncodingCrOnly.errors[0]?.row,
    2,
    "encoding-error row numbers count CR-only line endings correctly",
  );

  const crOnlyRows = parseCsv("name,city\rAda,London\rGrace,NYC");
  assertEqual(crOnlyRows.rows.length, 2, "CR-only files parse all rows");
  assertEqual(
    crOnlyRows.parsedRows[1]?.rowNumber,
    3,
    "CR-only files report correct source row numbers",
  );

  const invalidEncoding = parseCsv("name,city\nJos\uFFFD,Madrid");
  assertEqual(
    invalidEncoding.errors[0]?.code,
    "invalid_encoding",
    "csv parser rejects replacement characters as invalid encoding",
  );
  assertEqual(invalidEncoding.rows.length, 0, "csv parser does not import mojibake rows");
  assertEqual(
    invalidEncoding.errors[0]?.row,
    2,
    "csv parser reports the first offending line for encoding errors",
  );

  const blankHeader = parseCsv("name,\nAda,");
  assertEqual(blankHeader.rows.length, 0, "csv parser rejects blank headers");
  assertEqual(blankHeader.errors[0]?.code, "blank_header", "csv parser reports blank headers");

  const messy = parseCsv(
    '\uFEFFTitle;Dept;Notes\n"VP, Eng";Engineering;"owns platform\nand infra"\nController;Finance;ok\n',
    { delimiter: ";" },
  );
  assertEqual(messy.errors.length, 0, "csv parser accepts quoted newlines");
  assertEqual(messy.headers[0], "Title", "csv parser strips UTF-8 BOM from first header");
  assertEqual(messy.rows.length, 2, "csv parser keeps rows after quoted newline");
  assertEqual(
    messy.parsedRows[0]?.rowNumber,
    2,
    "csv parser records physical start row for quoted multiline row",
  );
  assertEqual(
    messy.parsedRows[1]?.rowNumber,
    4,
    "csv parser advances physical row after quoted newline",
  );
  assertEqual(
    messy.parsedRows[0]?.values.Title,
    "VP, Eng",
    "csv parser keeps delimiters inside quoted values",
  );
  assertEqual(
    messy.parsedRows[0]?.values.Notes,
    "owns platform\nand infra",
    "csv parser preserves newline inside quoted values",
  );
  assertEqual(
    inferCsvDelimiter("Title;Dept;Notes\nVP Eng;Engineering;owns platform\n"),
    ";",
    "csv parser infers semicolon delimiters for artifact construction",
  );

  const spacedQuote = parseCsv('a,b\n1, "hello,world"\n');
  assertEqual(
    spacedQuote.errors.length,
    0,
    "csv parser accepts optional leading space before quoted fields",
  );
  assertEqual(
    spacedQuote.parsedRows[0]?.values.b,
    "hello,world",
    "csv parser keeps delimiters inside space-prefixed quoted fields",
  );

  const strayQuote = parseCsv('a,b\n1,he"llo\n2,world\n');
  assertEqual(
    strayQuote.errors.length,
    0,
    "csv parser treats stray quotes in unquoted fields as data",
  );
  assertEqual(strayQuote.rows.length, 2, "csv parser does not merge rows after a stray quote");
  assertEqual(
    strayQuote.parsedRows[0]?.values.b,
    'he"llo',
    "csv parser preserves stray quote text",
  );
  assertEqual(
    strayQuote.parsedRows[1]?.values.b,
    "world",
    "csv parser keeps the following row separate",
  );

  const longCellValue = "x".repeat(700);
  const longCellParsed = parseCsv(`name,notes\nAda,${longCellValue}\n`);
  assertEqual(
    longCellParsed.parsedRows[0]?.values.notes?.length,
    longCellValue.length,
    "csv parser keeps full cell values; truncation belongs to analyzer presentation",
  );

  const profile = profileCsvParseResult(parsed, {
    sampleRowLimit: 2,
    sampleValueLimit: 2,
  });

  assertEqual(profile.rowCount, 3, "csv profile records parsed row count");
  assertEqual(profile.columnCount, 3, "csv profile records column count");
  assertEqual(profile.parseIssueCount, 1, "csv profile records parse issue count");
  assertEqual(profile.sampleRows.length, 2, "csv profile caps sample rows");
  assertEqual(
    profile.sampleRows[1]?.rowNumber,
    4,
    "csv profile sample rows keep source row numbers",
  );
  assertEqual(
    profile.sampleRows[0]?.cells[2]?.value,
    "SF",
    "csv profile sample rows keep cell values",
  );
  const nameColumn = profile.columns.find((column) => column.column === "employee_name");
  assert(nameColumn != null, "csv profile includes a profile for each column");
  assertEqual(nameColumn?.nonEmptyCount, 3, "csv profile counts non-empty column values");
  assertEqual(nameColumn?.sampleValues.length, 2, "csv profile caps distinct sample values");
  assertEqual(nameColumn?.sampleValues[0], "Ada Lovelace", "csv profile keeps first sample value");
  assertEqual(
    nameColumn?.sampleValues[1],
    "Grace Hopper",
    "csv profile keeps distinct sample values",
  );

  const emptyProfile = profileCsvParseResult(parsed, {
    sampleRowLimit: -1,
    sampleValueLimit: Number.NaN,
  });
  assertEqual(emptyProfile.sampleRows.length, 0, "csv profile clamps negative sample-row limits");
  assertEqual(
    emptyProfile.columns[0]?.sampleValues.length,
    3,
    "csv profile ignores non-finite sample-value limits",
  );
}

describe("csv parser engine", () => {
  it("stops scanning at the row limit without parsing a malformed tail", () => {
    const parsed = parseCsv('name\nA\nB\nC\n"unterminated', { maxRows: 2 });
    nodeAssert.deepEqual(parsed.rows, [{ name: "A" }, { name: "B" }]);
    nodeAssert.deepEqual(
      parsed.errors.map(({ code, row }) => ({ code, row })),
      [{ code: "row_limit_exceeded", row: 4 }],
    );
  });

  it("bounds malformed records as well as successful rows", () => {
    const parsed = parseCsv('a,b\nwrong\nalso-wrong\nx,y\n"unterminated', { maxRows: 2 });
    nodeAssert.equal(parsed.rows.length, 0);
    nodeAssert.deepEqual(
      parsed.errors.map(({ code, row }) => ({ code, row })),
      [
        { code: "column_count_mismatch", row: 2 },
        { code: "column_count_mismatch", row: 3 },
        { code: "row_limit_exceeded", row: 4 },
      ],
    );
  });

  it("counts quoted multiline records and ignores blank lines at the row limit", () => {
    const parsed = parseCsv('name,note\nA,"one\ntwo"\n\nB,three\n\n', { maxRows: 2 });
    nodeAssert.deepEqual(parsed.errors, []);
    nodeAssert.deepEqual(
      parsed.parsedRows.map((row) => row.rowNumber),
      [2, 5],
    );
    nodeAssert.equal(parsed.rows[0]?.note, "one\ntwo");
    nodeAssert.equal(
      inferCsvDelimiter('name;note\nA;one\nB;two\nC;three\n"unterminated', { maxRows: 2 }),
      ";",
    );
  });

  it("parses and profiles CSV input", () => {
    testCsvParserEngine();
  });
});
