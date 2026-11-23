import { describe, expect, it } from "vite-plus/test";

import type { FieldValue, VisibleRecord } from "@contracts";

import {
  compileProposalToPendingWrites,
  type EditableGridProposalEnvelope,
} from "../proposal-compile";

function row(record_id: string, external_key?: string): VisibleRecord {
  return {
    record_id,
    external_key,
    effective_start: "2026-06-01",
    effective_end: null,
    values: {},
    custom_fields: [],
  };
}

const value = { type: "text", value: "Director" } satisfies FieldValue;

const positionFields = ["title", "level", "department"].map((id) => ({
  id,
  label: id,
  type: "text" as const,
  required: false,
}));

describe("compileProposalToPendingWrites", () => {
  it("binds record_id and external_key writes into record-level pending writes", () => {
    const envelope: EditableGridProposalEnvelope = {
      id: "proposal-1",
      grounding: null,
      writes: [
        {
          model: "position",
          record_key: { type: "record_id", value: "rec-A" },
          field: "title",
          value,
          effective_date: "2026-06-15",
          change_type_id: "agent_update",
        },
        {
          model: "position",
          record_key: { type: "external_key", value: "pos-b" },
          field: "level",
          value: { type: "text", value: "L5" },
          effective_date: "2026-06-15",
          change_type_id: "agent_update",
        },
      ],
    };

    const result = compileProposalToPendingWrites(envelope, {
      modelId: "position",
      records: [row("rec-A"), row("rec-B", "pos-b")],
      fields: positionFields,
      sourceRef: "run_123",
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.writes).toEqual([
      {
        rowKey: "rec-A",
        modelId: "position",
        effectiveStart: "2026-06-15",
        sourceKind: "agent",
        sourceRef: "run_123",
        changeTypeId: "agent_update",
        sourceWriteIndices: [0],
        sourceWriteIndicesByField: { title: [0] },
        values: { title: value },
      },
      {
        rowKey: "rec-B",
        modelId: "position",
        effectiveStart: "2026-06-15",
        sourceKind: "agent",
        sourceRef: "run_123",
        changeTypeId: "agent_update",
        sourceWriteIndices: [1],
        sourceWriteIndicesByField: { level: [1] },
        values: { level: { type: "text", value: "L5" } },
      },
    ]);
  });

  it("aggregates record binding and per-record conflicts without dropping diagnostics", () => {
    const envelope: EditableGridProposalEnvelope = {
      id: "proposal-1",
      grounding: null,
      writes: [
        {
          model: "employee",
          record_key: { type: "record_id", value: "rec-A" },
          field: "title",
          value,
          effective_date: "2026-06-15",
        },
        {
          model: "position",
          record_key: { type: "record_id", value: "missing" },
          field: "title",
          value,
          effective_date: "2026-06-15",
        },
        {
          model: "position",
          record_key: { type: "external_key", value: "dupe" },
          field: "title",
          value,
          effective_date: "2026-06-15",
        },
        {
          model: "position",
          record_key: { type: "record_id", value: "rec-A" },
          field: "title",
          value,
          effective_date: "2026-06-15",
          change_type_id: "type_a",
        },
        {
          model: "position",
          record_key: { type: "record_id", value: "rec-A" },
          field: "level",
          value,
          effective_date: "2026-07-01",
          change_type_id: "type_b",
        },
        {
          model: "position",
          record_key: { type: "record_id", value: "rec-A" },
          field: "department",
          value,
          effective_date: "2026-06-15",
          change_type_id: "type_b",
        },
      ],
    };

    const result = compileProposalToPendingWrites(envelope, {
      modelId: "position",
      records: [row("rec-A"), row("rec-B", "dupe"), row("rec-C", "dupe")],
      fields: positionFields,
    });

    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "wrong_model",
      "record_not_found",
      "ambiguous_record_key",
      "mixed_effective_date",
      "mixed_change_type",
    ]);
    expect(result.writes).toHaveLength(1);
    expect(result.writes[0]!.values).toEqual({ title: value });
    expect(result.writes[0]!.sourceWriteIndices).toEqual([3]);
    expect(result.writes[0]!.sourceWriteIndicesByField).toEqual({ title: [3] });
  });

  it("preserves envelope write indices when fields collapse into one record write", () => {
    const result = compileProposalToPendingWrites(
      {
        id: "proposal-1",
        grounding: null,
        writes: [
          {
            model: "position",
            record_key: { type: "record_id", value: "rec-A" },
            field: "title",
            value,
            effective_date: "2026-06-15",
          },
          {
            model: "position",
            record_key: { type: "record_id", value: "rec-A" },
            field: "level",
            value: { type: "text", value: "L6" },
            effective_date: "2026-06-15",
          },
        ],
      },
      {
        modelId: "position",
        records: [row("rec-A")],
        fields: positionFields,
      },
    );

    expect(result.diagnostics).toEqual([]);
    expect(result.writes).toHaveLength(1);
    expect(result.writes[0]!.sourceWriteIndices).toEqual([0, 1]);
    expect(result.writes[0]!.sourceWriteIndicesByField).toEqual({
      level: [1],
      title: [0],
    });
    expect(result.writes[0]!.values).toEqual({
      title: value,
      level: { type: "text", value: "L6" },
    });
  });
});

describe("compileProposalToPendingWrites with model fields", () => {
  const fields = [
    { id: "title", label: "Title", type: "text" as const, required: true },
    { id: "cf_code", label: "Cost code", type: "text" as const, required: false },
  ];

  function clearOf(field: string): EditableGridProposalEnvelope {
    return {
      id: "p",
      grounding: null,
      writes: [
        {
          model: "position",
          record_key: { type: "record_id", value: "r-1" },
          field,
          value: null,
          effective_date: "2026-06-15",
        },
      ],
    };
  }

  it("keeps clears of optional fields as null pending values", () => {
    const result = compileProposalToPendingWrites(clearOf("cf_code"), {
      modelId: "position",
      records: [row("r-1")],
      fields,
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.writes[0]!.values).toEqual({ cf_code: null });
  });

  it("rejects clearing a required field", () => {
    expect(
      compileProposalToPendingWrites(clearOf("title"), {
        modelId: "position",
        records: [row("r-1")],
        fields,
      }),
    ).toEqual({
      writes: [],
      diagnostics: [
        {
          path: "writes.0.value",
          code: "field_not_clearable",
          message: "Title is required and can't be cleared.",
        },
      ],
    });
  });
});
