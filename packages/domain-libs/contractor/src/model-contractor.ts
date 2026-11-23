import {
  enumFieldFromLookupSeedRows,
  type LookupSeedRow,
  type ModelBlock,
} from "@domain-libs/_shared";

const CONTRACTOR_TYPE_SEED_ROWS: readonly LookupSeedRow[] = [
  {
    external_key: "consultant",
    values: { name: "Consultant", known_aliases: [] },
  },
  {
    external_key: "freelancer",
    values: { name: "Freelancer", known_aliases: [] },
  },
  {
    external_key: "agency",
    values: { name: "Agency", known_aliases: [] },
  },
  { external_key: "temp", values: { name: "Temp", known_aliases: [] } },
];

export const model_contractor_blocks: ModelBlock[] = [
  {
    name: "contractor",
    kind: "entity",
    label: "Contractor",
    // Suggested UI clusters: contractor_summary (id, name, name_last, name_first, name_display); contractor_employment (title, pay, start_date, end_date, department, reports_to, location, annualized_cost).
    fields: {
      // Previously essential.
      id: {
        type: "text",
        label: "Contractor ID",
        is_unique: true,
      },
      name: {
        type: "text",
        label: "Full Legal Name",
      },
      title: { type: "text", label: "Title" },
      pay: {
        type: "money_rate",
        label: "Payment Rate",
      },
      start_date: {
        type: "date",
        label: "Start Date",
      },
      end_date: {
        type: "date",
        label: "End Date",
      },
      department: {
        target_model: "department",
        label: "Department",
      },
      // Previously templated.
      name_last: {
        type: "text",
        label: "Last Name",
      },
      name_first: {
        type: "text",
        label: "First Name",
      },
      name_display: {
        type: "text",
        label: "Display Name",
      },
      reports_to: {
        target_model: "employee",
        label: "Manager",
      },
      type: enumFieldFromLookupSeedRows(CONTRACTOR_TYPE_SEED_ROWS, {
        label: "Contractor Type",
      }),
      location: {
        target_model: "location",
        label: "Work location",
      },
      annualized_cost: {
        type: "money_rate",
        label: "Annualized Cost",
      },
    },
  },
];
