import { describe, expect, it } from "vite-plus/test";

import type { CsvWorkspaceContext } from "../types";
import { buildCsvWorkspacePresentation } from "../presentation";

const context = {
  schema: {
    app_id: "laboratory_intake",
    customer_id: "north_lab",
    schema_revision_id: 1,
    version: "v1",
    models: [
      {
        id: "rack",
        kind: "entity",
        name: "Rack",
        label: "Rack",
        record_label: "rack",
        display_field_id: "caption",
        fields: [{ id: "caption", name: "Caption", label: "Caption", type: "text" }],
      },
      {
        id: "specimen",
        kind: "entity",
        name: "Specimen",
        label: "Specimen",
        record_label: "specimen",
        display_field_id: "title",
        fields: [
          { id: "title", name: "Title", label: "Title", type: "text" },
          {
            id: "rack",
            name: "Rack",
            label: "Rack",
            type: "relation",
            target_model: "rack",
          },
        ],
      },
    ],
    change_types: [
      { id: "unrelated_alpha", label: "Alpha", target_model: "rack", touches: [] },
      { id: "unrelated_beta", label: "Beta", target_model: "rack", touches: [] },
    ],
  },
  scope: { appId: "laboratory_intake", customerId: "north_lab" },
  actorId: "lab-reviewer",
  asOf: "2027-03-15",
  recoveryContext: {
    appId: "laboratory_intake",
    customerId: "north_lab",
    actorId: "lab-reviewer",
    asOf: "2027-03-15",
  },
  policies: [],
  recordsByModel: {
    rack: [
      {
        record_id: "rack-1",
        effective_start: "2027-03-15",
        effective_end: null,
        custom_fields: [],
        values: { caption: { type: "text", value: "North freezer" } },
      },
    ],
    specimen: [],
  },
  activity: [],
} as unknown as CsvWorkspaceContext;

describe("CSV workspace presentation", () => {
  it("uses declared display fields and does not invent change-type names", () => {
    const presentation = buildCsvWorkspacePresentation(context, null);
    const rackOverride = presentation.fieldOverridesByModel.specimen?.rack;

    expect(rackOverride?.relationOptions).toEqual([
      { key: { type: "record_id", value: "rack-1" }, label: "North freezer" },
    ]);
    expect(presentation.models).toEqual([
      { modelId: "rack", label: "Rack" },
      { modelId: "specimen", label: "Specimen" },
    ]);
  });

  it("tells unnamed targets apart by external key, else start date", () => {
    const unnamed = (recordId: string, externalKey: string | null) => ({
      record_id: recordId,
      external_key: externalKey,
      effective_start: "2027-01-02",
      effective_end: null,
      custom_fields: [],
      values: {},
    });
    const presentation = buildCsvWorkspacePresentation(
      {
        ...context,
        recordsByModel: {
          ...context.recordsByModel,
          rack: [
            ...context.recordsByModel.rack!,
            unnamed("rack-2", "R-2"),
            unnamed("rack-3", null),
          ],
        },
      } as CsvWorkspaceContext,
      null,
    );
    const labels = presentation.fieldOverridesByModel.specimen?.rack?.relationOptions?.map(
      (option) => option.label,
    );
    expect(labels).toEqual([
      "North freezer",
      "Unnamed rack (R-2)",
      "Unnamed rack (since 2027-01-02)",
    ]);
  });
});
