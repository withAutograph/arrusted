import { LOOKUP_MODEL_FIELDS, type LookupSeedRow, type ModelBlock } from "@domain-libs/_shared";

export const ETHNICITY_SEED_ROWS: readonly LookupSeedRow[] = [
  {
    external_key: "hispanic",
    values: {
      name: "Hispanic or Latino",
      known_aliases: ["hispanic", "latino"],
    },
  },
  {
    external_key: "white",
    values: {
      name: "White",
      known_aliases: ["white", "caucasian"],
    },
  },
  {
    external_key: "asian",
    values: { name: "Asian", known_aliases: ["asian"] },
  },
  {
    external_key: "black",
    values: {
      name: "Black or African American",
      known_aliases: ["black", "african_american"],
    },
  },
  {
    external_key: "multiracial",
    values: {
      name: "Two or More Races",
      known_aliases: ["multiracial", "mixed"],
    },
  },
  {
    external_key: "native",
    values: {
      name: "American Indian or Alaska Native",
      known_aliases: ["native_american", "indigenous", "american_indian", "alaska_native"],
    },
  },
  {
    external_key: "pacific",
    values: {
      name: "Native Hawaiian or Other Pacific Islander",
      known_aliases: ["pacific_islander", "native_hawaiian"],
    },
  },
];

export const GENDER_SEED_ROWS: readonly LookupSeedRow[] = [
  {
    external_key: "m",
    values: { name: "Male", known_aliases: ["male", "M"] },
  },
  {
    external_key: "f",
    values: { name: "Female", known_aliases: ["female", "F"] },
  },
  {
    external_key: "o",
    values: { name: "Other", known_aliases: ["other", "O"] },
  },
  {
    external_key: "nb",
    values: {
      name: "Non-binary",
      known_aliases: ["non-binary", "NB"],
    },
  },
  {
    external_key: "nd",
    values: {
      name: "Not disclosed",
      known_aliases: ["undisclosed", "prefer_not_to_disclose"],
    },
  },
];

export const MARITAL_STATUS_SEED_ROWS: readonly LookupSeedRow[] = [
  {
    external_key: "single",
    values: { name: "Single", known_aliases: [] },
  },
  {
    external_key: "married",
    values: { name: "Married", known_aliases: [] },
  },
  {
    external_key: "divorced",
    values: { name: "Divorced", known_aliases: [] },
  },
  {
    external_key: "widowed",
    values: { name: "Widowed", known_aliases: [] },
  },
  {
    external_key: "separated",
    values: { name: "Separated", known_aliases: [] },
  },
  {
    external_key: "domestic_partnership",
    values: {
      name: "Domestic Partnership",
      known_aliases: ["domestic_partner"],
    },
  },
];

export const WFH_POLICY_SEED_ROWS: readonly LookupSeedRow[] = [
  {
    external_key: "full_remote",
    values: { name: "Fully Remote", known_aliases: [] },
  },
  {
    external_key: "hybrid",
    values: {
      name: "Hybrid (2-3 days office)",
      known_aliases: [],
    },
  },
  {
    external_key: "office",
    values: { name: "Office Required", known_aliases: [] },
  },
  {
    external_key: "flexible",
    values: { name: "Flexible", known_aliases: [] },
  },
];

export const EMPLOYMENT_TYPE_SEED_ROWS: readonly LookupSeedRow[] = [
  {
    external_key: "full_time",
    values: {
      name: "Full Time",
      known_aliases: ["full_time", "FT"],
    },
  },
  {
    external_key: "part_time",
    values: {
      name: "Part Time",
      known_aliases: ["part_time", "PT"],
    },
  },
  {
    external_key: "intern",
    values: {
      name: "Intern",
      known_aliases: ["intern", "internship"],
    },
  },
  {
    external_key: "temp",
    values: {
      name: "Temporary",
      known_aliases: ["temporary", "temp"],
    },
  },
];

export const lookup_employee_profile_blocks: ModelBlock[] = [
  {
    name: "entity",
    kind: "lookup",
    label: "Entity",
    fields: {
      // Previously essential.
      ...LOOKUP_MODEL_FIELDS,
      entity_name: { type: "text", label: "Legal Name" },
      // Previously templated.
      parent_entity: { target_model: "entity", label: "Parent" },
    },
  },
];

export const lookup_employee_workforce_blocks: ModelBlock[] = [];
