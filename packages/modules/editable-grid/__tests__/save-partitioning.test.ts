import { describe, expect, it } from "vite-plus/test";

import type { EditEntry } from "../../../engines/edit-buffer/index";

import { entriesToWrites, partitionEntriesForSave } from "../save-partitioning";

function attributedEntry(
  rowKey: string,
  source: EditEntry["source"],
  sourceKind: string,
  sourceRef: string | null,
  changeTypeId: string,
): EditEntry {
  return {
    addr: { rowKey, fieldId: "title" },
    value: { type: "text", value: rowKey },
    source,
    meta: {
      modelId: "position",
      effectiveStart: "2026-06-15",
      sourceKind,
      sourceRef,
      changeTypeId,
    },
  };
}

function entry(rowKey: string, sourceRef: string | null): EditEntry {
  return attributedEntry(rowKey, "agent", "agent", sourceRef, "position_update");
}

describe("partitionEntriesForSave", () => {
  it("keeps same-change-type agent runs in separate save partitions", () => {
    const partitions = partitionEntriesForSave([entry("rec-A", "run-1"), entry("rec-B", "run-2")], {
      defaultChangeType: "position_update",
      defaultSourceKind: "user",
      defaultSourceRef: null,
    });

    expect(
      partitions.map((partition) => ({
        sourceKind: partition.sourceKind,
        sourceRef: partition.sourceRef,
        changeTypeId: partition.changeTypeId,
        rows: partition.entries.map((e) => e.addr.rowKey),
      })),
    ).toEqual([
      {
        sourceKind: "agent",
        sourceRef: "run-1",
        changeTypeId: "position_update",
        rows: ["rec-A"],
      },
      {
        sourceKind: "agent",
        sourceRef: "run-2",
        changeTypeId: "position_update",
        rows: ["rec-B"],
      },
    ]);
  });

  it("keeps null and empty source refs in separate save partitions", () => {
    const partitions = partitionEntriesForSave([entry("rec-A", null), entry("rec-B", "")], {
      defaultChangeType: "position_update",
      defaultSourceKind: "user",
      defaultSourceRef: null,
    });

    expect(
      partitions.map((partition) => ({
        sourceKind: partition.sourceKind,
        sourceRef: partition.sourceRef,
        rows: partition.entries.map((e) => e.addr.rowKey),
      })),
    ).toEqual([
      { sourceKind: "agent", sourceRef: null, rows: ["rec-A"] },
      { sourceKind: "agent", sourceRef: "", rows: ["rec-B"] },
    ]);
  });

  it("uses an explicit workflow source without collapsing distinct change types", () => {
    const partitions = partitionEntriesForSave(
      [
        attributedEntry("hand-edited", "user", "user", null, "position_update"),
        attributedEntry("imported", "import", "data_import", "run-1", "position_update"),
        attributedEntry("other-type", "import", "data_import", "run-1", "employee_update"),
      ],
      {
        defaultChangeType: "position_update",
        defaultSourceKind: "user",
        defaultSourceRef: null,
        saveSource: { sourceKind: "data_import", sourceRef: "run-1" },
      },
    );

    expect(
      partitions.map((partition) => [
        partition.sourceKind,
        partition.sourceRef,
        partition.changeTypeId,
        partition.entries.map((item) => item.addr.rowKey),
      ]),
    ).toEqual([
      ["data_import", "run-1", "position_update", ["hand-edited", "imported"]],
      ["data_import", "run-1", "employee_update", ["other-type"]],
    ]);
  });
});

describe("entriesToWrites create subjects", () => {
  it("emits the caller-selected permanent UUID for a new record", () => {
    const writes = entriesToWrites(
      [
        {
          addr: { rowKey: "tmp:employee-1", fieldId: "name" },
          value: { type: "text", value: "Sarah Chen" },
          meta: {
            modelId: "employee",
            newRecordId: "018f6bf3-1ea5-7812-9a5a-a1f5b04f0100",
            effectiveStart: "2026-06-15",
          },
        },
      ],
      "employee",
    );

    expect(writes).toEqual([
      {
        model_id: "employee",
        new_record_id: "018f6bf3-1ea5-7812-9a5a-a1f5b04f0100",
        effective_start: "2026-06-15",
        values: { name: { type: "text", value: "Sarah Chen" } },
      },
    ]);
  });

  it("rejects a row carrying both existing and new subject forms", () => {
    expect(() =>
      entriesToWrites(
        [
          {
            addr: { rowKey: "tmp:employee-1", fieldId: "name" },
            value: { type: "text", value: "Sarah Chen" },
            meta: {
              modelId: "employee",
              recordKey: { type: "record_id", value: "rec-existing" },
              newRecordId: "018f6bf3-1ea5-7812-9a5a-a1f5b04f0100",
              effectiveStart: "2026-06-15",
            },
          },
        ],
        "employee",
      ),
    ).toThrow("cannot have both recordKey and newRecordId");
  });

  it("rejects conflicting subject metadata split across cells in one row", () => {
    expect(() =>
      entriesToWrites(
        [
          {
            addr: { rowKey: "employee-1", fieldId: "name" },
            value: { type: "text", value: "Sarah Chen" },
            meta: {
              modelId: "employee",
              newRecordId: "018f6bf3-1ea5-7812-9a5a-a1f5b04f0100",
              effectiveStart: "2026-06-15",
            },
          },
          {
            addr: { rowKey: "employee-1", fieldId: "email" },
            value: { type: "text", value: "sarah@example.com" },
            meta: {
              modelId: "employee",
              recordKey: { type: "record_id", value: "rec-existing" },
              effectiveStart: "2026-06-15",
            },
          },
        ],
        "employee",
      ),
    ).toThrow("conflicting subject metadata");
  });
});
