import {
  LOOKUP_MODEL_FIELDS,
  placeholderEnumField,
  type LookupSeedRow,
  type ImportIdentityPolicy,
  type ModelBlock,
} from "@domain-libs/_shared";

const JOB_FAMILY_SEED_ROWS: readonly LookupSeedRow[] = [
  {
    external_key: "sales",
    values: { name: "Sales", known_aliases: [] },
  },
  {
    external_key: "cx",
    values: {
      name: "Customer Success",
      known_aliases: ["Customer Service"],
    },
  },
  {
    external_key: "marketing",
    values: { name: "Marketing", known_aliases: [] },
  },
  {
    external_key: "engineering",
    values: { name: "Engineering", known_aliases: [] },
  },
  {
    external_key: "product",
    values: { name: "Product", known_aliases: [] },
  },
  {
    external_key: "design",
    values: { name: "Design", known_aliases: [] },
  },
  {
    external_key: "finance",
    values: { name: "Finance", known_aliases: [] },
  },
  {
    external_key: "legal",
    values: { name: "Legal", known_aliases: [] },
  },
  { external_key: "hr", values: { name: "HR", known_aliases: [] } },
  {
    external_key: "operations",
    values: { name: "Operations", known_aliases: [] },
  },
  {
    external_key: "talent",
    values: { name: "Talent", known_aliases: ["Recruiting"] },
  },
];

const LEVEL_SEED_ROWS: readonly LookupSeedRow[] = [
  {
    external_key: "l2",
    values: { name: "L2", known_aliases: ["IC2"] },
  },
  {
    external_key: "l3",
    values: { name: "L3", known_aliases: ["IC3"] },
  },
  {
    external_key: "l4",
    values: { name: "L4", known_aliases: ["IC4"] },
  },
  {
    external_key: "l5",
    values: { name: "L5", known_aliases: ["IC5"] },
  },
  {
    external_key: "l6",
    values: { name: "L6", known_aliases: ["IC6"] },
  },
  {
    external_key: "l7",
    values: { name: "L7", known_aliases: ["IC7"] },
  },
  {
    external_key: "l8",
    values: { name: "L8", known_aliases: ["IC8"] },
  },
  {
    external_key: "l9",
    values: { name: "L9", known_aliases: ["IC9"] },
  },
  {
    external_key: "l10",
    values: { name: "L10", known_aliases: ["IC10"] },
  },
];

export const lookup_compensation_blocks: ModelBlock[] = [
  {
    name: "job_family",
    kind: "lookup",
    label: "Job Family",
    fields: {
      // Previously essential.
      ...LOOKUP_MODEL_FIELDS,
      // Previously templated.
      commissioned: { type: "bool", label: "Commissioned?" },
      notes: { type: "text", label: "Notes" },
    },
    seed_rows: JOB_FAMILY_SEED_ROWS,
  },
  {
    name: "level",
    kind: "lookup",
    label: "Level",
    fields: {
      // Previously essential.
      ...LOOKUP_MODEL_FIELDS,
      // Previously templated.
      job_family: { target_model: "job_family", label: "Job Family" },
      base_low: { type: "money_rate", label: "Base Salary (Low)" },
      base_target: { type: "money_rate", label: "Base Salary (Target)" },
      base_high: { type: "money_rate", label: "Base Salary (High)" },
      tc_high: { type: "money_rate", label: "Total Comp (High)" },
      tc_target: { type: "money_rate", label: "Total Comp (Target)" },
      tc_low: { type: "money_rate", label: "Total Comp (Low)" },
      bonus_percent: { type: "number", label: "Bonus %" },
      ote_target: { type: "money_rate", label: "On-Target Earnings (Target)" },
      ote_low: { type: "money_rate", label: "On-Target Earnings (Low)" },
      ote_high: { type: "money_rate", label: "On-Target Earnings (High)" },
      variable_portion: { type: "number", label: "Variable Portion" },
      total_share_grant: { type: "number", label: "Total Share Grant" },
      annual_equity_value: {
        type: "money_rate",
        label: "Annualized Equity Value",
      },
    },
    seed_rows: LEVEL_SEED_ROWS,
  },
  {
    name: "comp_zone",
    kind: "lookup",
    label: "Compensation Zones",
    fields: {
      // Previously essential.
      ...LOOKUP_MODEL_FIELDS,
      base_adjustment: { type: "number", label: "Base Salary Adjustment (%)" },
      notes: { type: "text", label: "Notes" },
    },
  },
  {
    name: "bonus",
    kind: "entity",
    label: "Bonus Payments",
    fields: {
      // Previously essential.
      issuance_date: { type: "date", label: "Bonus Date" },
      recipient: { target_model: "employee", label: "Bonus Recipient" },
      bonus_reason: placeholderEnumField({
        label: "Reason for Bonus",
      }),
      start_date: { type: "date", label: "Bonus Period Start" },
      end_date: { type: "date", label: "Bonus Period End" },
    },
  },
];

export const job_family_import_identity_policy = {
  modelId: "job_family",
  rungs: [
    { fieldId: "name", kind: "name" },
    { fieldId: "name", aliasFieldId: "known_aliases", kind: "alias" },
  ],
} as const satisfies ImportIdentityPolicy;

export const level_import_identity_policy = {
  modelId: "level",
  rungs: [
    { fieldId: "name", kind: "name" },
    { fieldId: "name", aliasFieldId: "known_aliases", kind: "alias" },
  ],
} as const satisfies ImportIdentityPolicy;
