import type { FieldValue, VisibleRecord } from "@contracts";
import type { WorkspaceDraft, WorkspaceRow } from "@autograph/csv-workspace";

export const freshCustomerContext = {
  appId: "laboratory_intake",
  customerId: "north_lab",
  actorId: "north-lab-reviewer",
  asOf: "2027-03-15",
};

export const freshCustomerPolicies = [
  {
    modelId: "rack",
    rungs: [
      { kind: "name", fieldId: "caption" },
      { kind: "alias", fieldId: "caption", aliasFieldId: "alternate_labels" },
    ],
  },
  { modelId: "specimen", rungs: [{ kind: "unique", fieldId: "accession" }] },
  { modelId: "observation", rungs: [{ kind: "composite", fieldIds: ["specimen", "observed_on"] }] },
] as const;

export function freshCustomerRecordLabel({
  model,
  record,
}: {
  model: { id: string };
  record: VisibleRecord;
}): string | undefined {
  const title = model.id === "specimen" ? record.values.title : undefined;
  return title?.type === "text" ? title.value : undefined;
}

export const freshCustomerInstructions =
  "This laboratory receives specimens into storage racks and records one observation per specimen and observation date. Accession identifies a specimen. Rack captions are canonical labels; alternate_labels provides older labels. A source rack alias never requests renaming the rack. New racks and specimens may be created together with their observations. Blank specimen notes leave existing notes unchanged. Readings are decimal values. The source observation date belongs in observed_on; row effective dates use the run date.";

export const initialInstruction =
  "Import both laboratory intake rows. Update the existing specimen note when supplied, preserve its accession and title, and prepare each observation with its specimen and rack relationships.";

export const FRESH_IDS = {
  coldRack: "de47894b-6ff0-4bcc-bdb0-000000000001",
  archiveRack: "de47894b-6ff0-4bcc-bdb0-000000000002",
  existingSpecimen: "de47894b-6ff0-4bcc-bdb0-000000000003",
} as const;

const text = (value: string): FieldValue => ({ type: "text", value });
const relation = (value: string): FieldValue => ({
  type: "relation",
  value: { type: "record_id", value },
});
const seedRow = (
  modelId: string,
  recordId: string,
  values: WorkspaceRow["values"],
): WorkspaceRow => ({
  rowId: recordId,
  modelId,
  recordId,
  operation: "create",
  effectiveStart: "2027-03-01",
  values,
  clearFields: [],
});

const freshCustomerSeedDraft: WorkspaceDraft = {
  revision: 0,
  rows: [
    seedRow("rack", FRESH_IDS.coldRack, {
      caption: text("Cold Storage"),
      alternate_labels: { type: "text_list", value: ["Cold Bay"] },
    }),
    seedRow("rack", FRESH_IDS.archiveRack, { caption: text("Archive") }),
    seedRow("specimen", FRESH_IDS.existingSpecimen, {
      accession: text("LAB-001"),
      title: text("Plasma aliquot"),
      rack: relation(FRESH_IDS.coldRack),
      notes: text("Keep chilled"),
    }),
  ],
};

export function seedRecordsByModel(): Map<string, VisibleRecord[]> {
  const records = new Map<string, VisibleRecord[]>(
    freshCustomerPolicies.map(({ modelId }) => [modelId, []]),
  );
  for (const row of freshCustomerSeedDraft.rows) {
    records.get(row.modelId)!.push({
      record_id: row.recordId,
      effective_start: row.effectiveStart,
      values: structuredClone(row.values),
      custom_fields: [],
    });
  }
  return records;
}

export const expected = {
  rowCount: 2,
  modelIds: ["rack", "specimen", "observation"],
  newRackCaption: "Ambient Bench",
  existing: {
    accession: "LAB-001",
    title: "Plasma aliquot",
    notes: "Intake verified",
    reading: "12.50",
  },
  created: { accession: "LAB-002", title: "Control vial", reading: "7.25" },
  exactCaption: { input: "Archive", recordId: FRESH_IDS.archiveRack },
  alias: { input: "Cold Bay", recordId: FRESH_IDS.coldRack, canonicalCaption: "Cold Storage" },
} as const;
