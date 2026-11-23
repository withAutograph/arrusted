import {
  enumFieldFromLookupSeedRows,
  placeholderEnumField,
  defineFieldGroups,
  type LookupSeedRow,
  type ImportIdentityPolicy,
  type ModelBlock,
} from "@domain-libs/_shared";

import {
  EMPLOYMENT_TYPE_SEED_ROWS,
  ETHNICITY_SEED_ROWS,
  GENDER_SEED_ROWS,
  MARITAL_STATUS_SEED_ROWS,
  WFH_POLICY_SEED_ROWS,
} from "./lookup-employee";
import { PERFORMANCE_RATING_SEED_ROWS } from "./lookup-performance";

const EMPLOYEE_STATUS_SEED_ROWS: readonly LookupSeedRow[] = [
  {
    external_key: "active",
    values: { name: "Active", known_aliases: ["Current"] },
  },
  {
    external_key: "pending",
    values: {
      name: "Pending",
      known_aliases: ["Onboarding", "Prehire"],
    },
  },
  {
    external_key: "inactive",
    values: {
      name: "Inactive",
      known_aliases: ["Terminated", "Retired"],
    },
  },
  {
    external_key: "on_leave",
    values: {
      name: "On Leave",
      known_aliases: ["Leave", "PTO"],
    },
  },
];

export const EMPLOYEE_FIELD_GROUPS = defineFieldGroups("employee", [
  {
    id: "summary",
    label: "Summary",
    fields: ["ref", "name", "known_aliases", "employment_status", "title"],
  },
  {
    id: "organization",
    label: "Organization",
    fields: [
      "department",
      "location",
      "country",
      "job_family",
      "cost_center",
      "geography",
      "business_unit",
      "team",
      "entity",
      "pnl_category",
      "level",
    ],
  },
  {
    id: "employment",
    label: "Employment",
    fields: ["start_date", "employment_type", "flsa_status", "wfh_policy", "pay_frequency"],
  },
  {
    id: "compensation",
    label: "Compensation",
    fields: [
      "base_salary",
      "target_bonus",
      "target_commission",
      "comp_zone",
      "compa_ratio_base",
      "compa_ratio_total",
      "total_share_grant",
      "total_shares_vested",
      "total_cash",
      "annual_equity_value",
      "total_comp",
      "annualized_cost",
      "benefits_actual",
      "benefits_cost",
      "taxes_actual",
      "taxes_cost",
    ],
  },
  {
    id: "personal",
    label: "Personal",
    fields: [
      "name_last",
      "name_first",
      "birth_date",
      "name_display",
      "gender",
      "avatar",
      "work_email",
      "personal_email",
      "mobile_phone",
      "home_location",
      "ethnicity",
      "marital_status",
      "hide_employee_info",
    ],
  },
  {
    id: "departure",
    label: "Departure",
    fields: [
      "end_date",
      "termination_reason",
      "termination_notes",
      "regrettable_classification",
      "severance_amount",
      "severance_notes",
      "voluntary_classification",
    ],
  },
  {
    id: "performance_capacity",
    label: "Performance & capacity",
    fields: [
      "skills",
      "last_promoted",
      "cx_capacity",
      "quota_capacity",
      "ramp_date",
      "segment",
      "initiative",
      "performance_rating_free",
      "performance_rating_structured",
      "mobility_notes",
      "reviewer",
    ],
  },
] as const);

export const model_employee_blocks: ModelBlock[] = [
  {
    name: "employee",
    kind: "entity",
    label: "Employee",
    field_groups: EMPLOYEE_FIELD_GROUPS,
    fields: {
      // Previously essential.
      ref: {
        type: "text",
        label: "Employee Ref",
        is_unique: true,
        notes:
          "Unique employee reference. Often an internal HRIS number like EMP-001 or alphanumeric ID.",
      },
      name: {
        type: "text",
        label: "Full Name",
        notes: 'Employee\'s full display name, typically "First Last".',
      },
      known_aliases: {
        type: "known_aliases",
        label: "Known Aliases",
        notes: "Confirmed alternate employee names used for deterministic import matching.",
      },
      employment_status: enumFieldFromLookupSeedRows(EMPLOYEE_STATUS_SEED_ROWS, {
        label: "Employment Status",
        notes: "Current employment state: active, terminated, on leave, etc.",
      }),
      title: {
        type: "text",
        label: "Job Title",
        notes: 'The employee\'s current job title, e.g. "Senior Software Engineer", "VP Sales".',
      },
      department: {
        target_model: "department",
        label: "Department",
        notes:
          "Organizational department the employee belongs to: Engineering, Sales, Marketing, etc.",
      },
      location: {
        target_model: "location",
        label: "Work Location",
        notes:
          'Office or work site. Often a city or office name like "SF HQ", "Remote - US", "New York"',
      },
      start_date: {
        type: "date",
        label: "Start Date",
        notes: "Hire date or employment start date.",
      },
      end_date: {
        type: "date",
        label: "Termination Date",
        notes: "Last day of employment. Null if currently active.",
      },
      base_salary: {
        type: "money_rate",
        label: "Base Salary",
        notes: "Annual base salary. Currency amount, often with $ or /yr.",
      },
      target_bonus: {
        type: "money_rate",
        label: "Target Bonus",
        notes: "Annual target bonus amount or percentage of base.",
      },
      target_commission: {
        type: "money_rate",
        label: "Target Commission",
        notes: "Annual target commission amount. Typically for sales roles.",
      },
      name_last: {
        type: "text",
        label: "Last Name",
        notes: "Employee's family/surname.",
      },
      name_first: {
        type: "text",
        label: "First Name",
        notes: "Employee's given/first name.",
      },
      // Previously templated.
      country: {
        type: "iso_country",
        label: "Country",
        notes: "Country of employment as an ISO 3166-1 alpha-2 code.",
      },
      birth_date: {
        type: "date",
        label: "Date of Birth",
        notes: "Employee's date of birth. Expect values on or before 2008.",
      },
      name_display: {
        type: "text",
        label: "Preferred Name",
        notes: "Preferred or display name if different from legal name.",
      },
      comp_zone: {
        target_model: "comp_zone",
        label: "Compensation Zone",
        notes: "Geographic compensation zone for pay banding.",
      },
      compa_ratio_base: {
        type: "number",
        label: "Compa‑Ratio (Base)",
      },
      compa_ratio_total: {
        type: "number",
        label: "Compa‑Ratio (Total)",
      },
      job_family: {
        target_model: "job_family",
        label: "Job Family",
        notes: "Job family grouping: Engineering, Design, Sales, Operations, etc.",
      },
      gender: enumFieldFromLookupSeedRows(GENDER_SEED_ROWS, {
        label: "Gender",
        notes: "Male, Female, Non-binary, or other gender identifiers.",
      }),
      cost_center: placeholderEnumField({
        label: "Cost Center",
        notes: "Financial cost center code for budgeting. Often a numeric code.",
      }),
      wfh_policy: enumFieldFromLookupSeedRows(WFH_POLICY_SEED_ROWS, {
        label: "Work From Home Status",
        notes: "Remote work policy: Remote, Hybrid, In-Office, etc.",
      }),
      avatar: {
        type: "text",
        label: "Profile Photo",
      },
      work_email: {
        type: "text",
        label: "Work Email",
        is_unique: true,
        notes: "Corporate email address.",
      },
      personal_email: {
        type: "text",
        label: "Personal Email Address",
        is_unique: true,
        notes: "Personal/non-work email.",
      },
      mobile_phone: {
        type: "text",
        label: "Mobile Phone Number",
        notes: "Personal or work mobile number.",
      },
      home_location: {
        type: "text",
        label: "Home Address",
        notes: "Home/residential address.",
      },
      ethnicity: enumFieldFromLookupSeedRows(ETHNICITY_SEED_ROWS, {
        label: "Ethnicity",
        notes: "EEO/diversity classification.",
      }),
      marital_status: enumFieldFromLookupSeedRows(MARITAL_STATUS_SEED_ROWS, {
        label: "Marital Status",
        notes: "Single, Married, Domestic Partner, etc.",
      }),
      termination_reason: placeholderEnumField({
        label: "Reason for Termination",
        notes: "Voluntary, Involuntary, Retirement, Layoff, etc.",
      }),
      termination_notes: {
        type: "text",
        label: "Termination Notes",
        notes: "Free-text notes about the termination.",
      },
      regrettable_classification: placeholderEnumField({
        label: "Regrettable Classification",
        notes: "Whether the departure was regrettable or non-regrettable.",
      }),
      pay_frequency: placeholderEnumField({
        label: "Pay Frequency",
        notes: "How often paid: Monthly, Bi-weekly, Semi-monthly, Weekly.",
      }),
      geography: {
        target_model: "geography",
        label: "Location Geo",
        notes: "Geographic region: AMER, EMEA, APAC, etc.",
      },
      severance_amount: {
        type: "money_rate",
        label: "Severance Amount",
        notes: "Severance payment amount.",
      },
      severance_notes: {
        type: "text",
        label: "Severance Notes",
        notes: "Free-text notes about severance terms.",
      },
      business_unit: {
        target_model: "business_unit",
        label: "Business Unit",
        notes:
          'Division or business unit within the organization. "EMEA", a product line, a geographical region.',
      },
      team: placeholderEnumField({
        label: "Team",
        notes:
          "Sub-team or secondary department grouping. Alternative if department is not present.",
      }),
      employment_type: enumFieldFromLookupSeedRows(EMPLOYMENT_TYPE_SEED_ROWS, {
        label: "Employment Type",
        notes: "Full-time, Part-time, Contract, Intern, etc.",
      }),
      hide_employee_info: {
        type: "bool",
        label: "Hide Employee's Info?",
      },
      entity: {
        target_model: "entity",
        label: "Legal Entity",
        notes: "Legal employing entity for multi-entity organizations.",
      },
      flsa_status: placeholderEnumField({
        label: "FLSA Status (Exempt / Nonexempt)",
        notes: "Exempt or Non-exempt under Fair Labor Standards Act. US-specific.",
      }),
      total_share_grant: {
        type: "number",
        label: "Total Shares Granted",
        notes: "Total equity shares granted to the employee.",
      },
      total_shares_vested: {
        type: "number",
        label: "Total Vested Shares",
        notes: "Number of shares that have vested.",
      },
      total_cash: {
        type: "money_rate",
        label: "Total Cash Compensation",
      },
      annual_equity_value: {
        type: "money_rate",
        label: "Annual Equity Award Value",
        notes: "Annual equity grant value in dollars.",
      },
      total_comp: {
        type: "money_rate",
        label: "Total Compensation",
      },
      annualized_cost: {
        type: "money_rate",
        label: "Annualized Cost",
      },
      benefits_actual: {
        type: "money_rate",
        label: "Benefits Actual",
        notes: "Actual benefits cost amount.",
      },
      benefits_cost: {
        type: "money_rate",
        label: "Benefits Cost",
      },
      taxes_actual: {
        type: "money_rate",
        label: "Employer Taxes Actual",
        notes: "Actual employer tax burden amount.",
      },
      taxes_cost: {
        type: "money_rate",
        label: "Employer Tax Cost",
      },
      last_promoted: {
        type: "date",
        label: "Last Promotion Date",
        notes: "Date of most recent promotion.",
      },
      voluntary_classification: placeholderEnumField({
        label: "Voluntary Classification",
        notes: "Whether termination was voluntary or involuntary.",
      }),
      skills: placeholderEnumField({
        label: "Skills",
        notes: "Employee skill tags.",
      }),
      cx_capacity: {
        type: "number",
        label: "Account Capacity",
        notes: "Number of accounts the employee can manage. Sales/CS metric.",
      },
      quota_capacity: {
        type: "money_rate",
        label: "Quota-carrying Capacity",
        notes: "Revenue quota capacity for sales roles.",
      },
      ramp_date: {
        type: "date",
        label: "Fully-Ramped Date",
        notes: "Date when employee reaches full productivity/quota.",
      },
      segment: {
        target_model: "segment",
        label: "Segment",
        notes: "Customer or market segment assignment.",
      },
      initiative: {
        target_model: "initiative",
        label: "Initiative",
        notes: "Strategic initiative the employee is mapped to.",
      },
      performance_rating_free: {
        type: "text",
        label: "Performance Rating (Free-form)",
        notes: 'Free-text performance rating (e.g. "Exceeds Expectations").',
      },
      performance_rating_structured: enumFieldFromLookupSeedRows(PERFORMANCE_RATING_SEED_ROWS, {
        label: "Performance Rating (Structured)",
        notes: "Structured rating from a defined scale.",
      }),
      mobility_notes: {
        type: "text",
        label: "Mobility Notes",
        notes: "Notes about employee's willingness/ability to relocate.",
      },
      reviewer: {
        target_model: "employee",
        label: "Reviewer",
        notes: "Person responsible for this employee's performance review.",
      },
      pnl_category: {
        target_model: "pnl_category",
        label: "P&L Category",
        notes: "Profit & loss line item classification.",
      },
      level: {
        target_model: "level",
        label: "Compensation Level",
        notes: "Job level for compensation bands: L1, L2, IC3, M1, etc.",
      },
    },
  },
];

export const employee_import_identity_policy = {
  modelId: "employee",
  rungs: [
    { fieldId: "ref", kind: "ref" },
    { fieldId: "work_email", kind: "unique", normalization: "case_insensitive" },
    { fieldId: "name", kind: "name" },
    { fieldId: "name", aliasFieldId: "known_aliases", kind: "alias" },
  ],
} as const satisfies ImportIdentityPolicy;
