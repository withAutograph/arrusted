import { describe, expect, it } from "vite-plus/test";

import { validateDataTableSpec } from "../DataTable.validation";

describe("validateDataTableSpec", () => {
  it("accepts unique column identities", () => {
    expect(
      validateDataTableSpec({
        columns: [
          { id: "name", label: "Name" },
          { id: "status", label: "Status" },
        ],
        rows: [],
      }).columns,
    ).toHaveLength(2);
  });

  it("rejects duplicate column identities", () => {
    expect(() =>
      validateDataTableSpec({
        columns: [
          { id: "duplicate", label: "One" },
          { id: "duplicate", label: "Two" },
        ],
        rows: [],
      }),
    ).toThrow("data_table.columns ids must be unique: duplicate");
  });

  it("validates the optional flat frame treatment", () => {
    expect(validateDataTableSpec({ columns: [], rows: [], frame: "flat" }).frame).toBe("flat");
    expect(validateDataTableSpec({ columns: [], rows: [], frame: "unknown" }).frame).toBe(
      "outlined",
    );
  });
});
