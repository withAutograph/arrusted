import type { ModelBlock } from "@domain-libs/_shared";

export const model_compensation_blocks: ModelBlock[] = [
  {
    name: "benefits_policy",
    kind: "entity",
    label: "Benefits Policy",
    // Suggested UI clusters: benefits_policy_summary (id, name, notes); benefits_policy_scope (country); benefits_policy_terms (annual_amount).
    fields: {
      // Previously essential.
      id: {
        type: "text",
        label: "Benefits Policy ID",
        is_unique: true,
      },
      name: {
        type: "text",
        label: "Policy Name",
      },
      country: {
        type: "iso_country",
        label: "Country",
        is_unique: true,
      },
      annual_amount: {
        type: "money_rate",
        label: "Annual Benefits Cost",
      },
      // Previously templated.
      notes: {
        type: "text",
        label: "Notes",
      },
    },
  },
  {
    name: "employer_tax_policy",
    kind: "entity",
    label: "Employer Tax Policy",
    // Suggested UI clusters: employer_tax_policy_summary (id, name, notes); employer_tax_policy_scope (country); employer_tax_policy_terms (rate_pct, annual_cap).
    fields: {
      // Previously essential.
      id: {
        type: "text",
        label: "Employer Tax Policy ID",
        is_unique: true,
      },
      name: {
        type: "text",
        label: "Policy Name",
      },
      country: {
        type: "iso_country",
        label: "Country",
        is_unique: true,
      },
      rate_pct: {
        type: "number",
        label: "Payroll Tax Rate (%)",
      },
      annual_cap: {
        type: "money_rate",
        label: "Annual Cap",
      },
      // Previously templated.
      notes: {
        type: "text",
        label: "Notes",
      },
    },
  },
];
