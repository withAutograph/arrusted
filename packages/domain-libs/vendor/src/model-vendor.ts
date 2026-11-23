import {
  enumFieldFromLookupSeedRows,
  type LookupSeedRow,
  type ModelBlock,
} from "@domain-libs/_shared";

const VENDOR_TYPE_SEED_ROWS: readonly LookupSeedRow[] = [
  { external_key: "software", values: { name: "Software", known_aliases: [] } },
  {
    external_key: "professional_services",
    values: { name: "Professional Services", known_aliases: ["consulting"] },
  },
  {
    external_key: "contractor",
    values: { name: "Contractor", known_aliases: ["contingent workforce", "staffing"] },
  },
  {
    external_key: "supplier",
    values: { name: "Supplier", known_aliases: ["physical goods", "logistics"] },
  },
  { external_key: "facilities", values: { name: "Facilities", known_aliases: [] } },
  { external_key: "other", values: { name: "Other", known_aliases: [] } },
];

const VENDOR_STATUS_SEED_ROWS: readonly LookupSeedRow[] = [
  {
    external_key: "active",
    values: { name: "Active", known_aliases: ["current"] },
  },
  {
    external_key: "inactive",
    values: { name: "Inactive", known_aliases: ["closed", "terminated"] },
  },
];

export const model_vendor_blocks: ModelBlock[] = [
  {
    name: "vendor",
    kind: "entity",
    label: "Vendor",
    fields: {
      id: {
        type: "text",
        label: "Vendor ID",
        is_unique: true,
      },
      name: { type: "text", label: "Vendor Name" },
      known_aliases: { type: "text_list", label: "Known Aliases" },
      status: enumFieldFromLookupSeedRows(VENDOR_STATUS_SEED_ROWS, {
        label: "Vendor Status",
      }),
      type: enumFieldFromLookupSeedRows(VENDOR_TYPE_SEED_ROWS, {
        label: "Vendor Type",
      }),
      department: {
        target_model: "department",
        label: "Owning Department",
      },
      owner: {
        target_model: "employee",
        label: "Spend Owned By",
      },
      entity_name: {
        type: "text",
        label: "Legal Entity Name",
      },
      default_chart_account: {
        target_model: "chart_account",
        label: "Default Chart Account",
      },
    },
  },
];
