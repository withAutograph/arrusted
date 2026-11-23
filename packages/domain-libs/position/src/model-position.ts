import {
  defineFieldGroups,
  enumFieldFromLookupSeedRows,
  type LookupSeedRow,
  type ImportIdentityPolicy,
  type ModelBlock,
} from "@domain-libs/_shared";

const POSITION_STATUS_SEED_ROWS: readonly LookupSeedRow[] = [
  {
    external_key: "pending",
    values: {
      name: "Pending",
      notes: "Position request is pending approval",
      known_aliases: ["requested", "unapproved"],
    },
  },
  {
    external_key: "open",
    values: {
      name: "Open",
      notes: "Position is open for hiring",
      known_aliases: ["open"],
    },
  },
  {
    external_key: "filled",
    values: {
      name: "Filled",
      notes: "Position is currently filled",
      known_aliases: ["filled"],
    },
  },
  {
    external_key: "paused",
    values: {
      name: "Paused",
      notes: "Hiring paused",
      known_aliases: ["on_hold", "on-hold", "paused"],
    },
  },
  {
    external_key: "closed",
    values: {
      name: "Closed",
      notes: "Position closed",
      known_aliases: ["closed", "archived", "eliminated"],
    },
  },
];

export const POSITION_FIELD_GROUPS = defineFieldGroups("position", [
  {
    id: "summary",
    label: "Summary",
    fields: ["ref", "name", "known_aliases", "position_status"],
  },
  {
    id: "organization",
    label: "Organization",
    fields: ["department", "location", "business_unit", "job_family", "level", "pnl_category"],
  },
  {
    id: "timing",
    label: "Timing",
    fields: ["start_date", "end_date"],
  },
  {
    id: "budget",
    label: "Budget",
    fields: [
      "base_salary",
      "target_bonus",
      "target_commission",
      "total_cash",
      "annual_equity_value",
      "total_comp",
      "annualized_cost",
      "actual_annualized_cost",
      "annualized_cost_variance",
      "benefits_actual",
      "benefits_cost",
      "taxes_actual",
      "taxes_cost",
    ],
  },
] as const);

export const model_position_blocks: ModelBlock[] = [
  {
    name: "position",
    kind: "entity",
    field_groups: POSITION_FIELD_GROUPS,
    fields: {
      // Previously essential.
      ref: {
        type: "text",
        label: "Position Ref",
        is_unique: true,
        notes: "Unique position reference. Often a code like POS-001 or an alphanumeric ID.",
      },
      name: {
        type: "text",
        label: "Position Name",
        notes:
          'Descriptive name for the budgeted position. "Senior Engineer", "Marketing Manager", etc.',
      },
      known_aliases: {
        type: "known_aliases",
        label: "Known Aliases",
        notes: "Confirmed alternate position names used for deterministic import matching.",
      },
      position_status: enumFieldFromLookupSeedRows(POSITION_STATUS_SEED_ROWS, {
        label: "Position Status",
        notes: "Open, Filled, Frozen, Eliminated, Hiring, etc.",
      }),
      base_salary: {
        type: "money_rate",
        label: "Budgeted Base",
        notes: "Budgeted base salary for the position. Currency amount.",
      },
      target_bonus: {
        type: "money_rate",
        label: "Budgeted Bonus",
        notes: "Budgeted target bonus amount.",
      },
      target_commission: {
        type: "money_rate",
        label: "Budgeted Commission",
        notes: "Budgeted target commission amount.",
      },
      start_date: {
        type: "date",
        label: "Budget Start",
        notes: "Expected start date for the position.",
      },
      end_date: {
        type: "date",
        label: "Budget End",
        notes: "Expected end date for the position.",
      },
      department: {
        target_model: "department",
        label: "Department",
        notes: "Department the position is budgeted under.",
      },
      location: {
        target_model: "location",
        label: "Work Location",
        notes: "Office, city or site for the position.",
      },
      // Previously templated.
      total_cash: {
        type: "money_rate",
        label: "Total Cash Comp",
      },
      business_unit: {
        target_model: "business_unit",
        label: "Business Unit",
        notes: "Business unit the position belongs to.",
      },
      job_family: {
        target_model: "job_family",
        label: "Job Family",
        notes: "Job family grouping for the position.",
      },
      level: {
        target_model: "level",
        label: "Level",
        notes: "Job or compensation level for the position.",
      },
      annual_equity_value: {
        type: "money_rate",
        label: "Equity Budget ($)",
        notes: "Budgeted annual equity value.",
      },
      total_comp: {
        type: "money_rate",
        label: "Total Compensation",
      },
      annualized_cost: {
        type: "money_rate",
        label: "Annualized Cost",
      },
      actual_annualized_cost: {
        type: "money_rate",
        label: "Actual Annualized Cost",
      },
      annualized_cost_variance: {
        type: "money_rate",
        label: "Annualized Cost Variance",
      },
      benefits_actual: {
        type: "money_rate",
        label: "Benefits Actual",
        notes: "Actual benefits cost for the position.",
      },
      benefits_cost: {
        type: "money_rate",
        label: "Benefits Cost",
      },
      taxes_actual: {
        type: "money_rate",
        label: "Employer Taxes Actual",
        notes: "Actual employer tax cost.",
      },
      taxes_cost: {
        type: "money_rate",
        label: "Employer Tax Cost",
      },
      pnl_category: {
        target_model: "pnl_category",
        label: "P&L Category",
        notes: "P&L line item classification for this position's cost.",
      },
    },
  },
];

export const position_import_identity_policy = {
  modelId: "position",
  rungs: [
    { fieldId: "ref", kind: "ref" },
    { fieldId: "name", kind: "name" },
    { fieldId: "name", aliasFieldId: "known_aliases", kind: "alias" },
  ],
} as const satisfies ImportIdentityPolicy;
