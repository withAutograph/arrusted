import { LOOKUP_MODEL_FIELDS } from "./lookup-helpers";
import type { ImportIdentityPolicy, LookupSeedRow, ModelBlock } from "./_types";

const PNL_CATEGORY_SEED_ROWS: readonly LookupSeedRow[] = [
  {
    external_key: "cogs",
    values: { name: "Cost of Goods Sold", known_aliases: [] },
  },
  {
    external_key: "r_and_d",
    values: { name: "R&D", known_aliases: ["r-and-d"] },
  },
  {
    external_key: "sales_marketing",
    values: {
      name: "Sales & Marketing",
      known_aliases: ["sales-marketing"],
    },
  },
  {
    external_key: "g_and_a",
    values: {
      name: "General & Administrative",
      known_aliases: ["g-and-a"],
    },
  },
];

const DEPARTMENT_SEED_ROWS: readonly LookupSeedRow[] = [
  {
    external_key: "engineering",
    values: { name: "Engineering", known_aliases: ["eng"] },
  },
  {
    external_key: "product",
    values: { name: "Product", known_aliases: ["prod"] },
  },
  {
    external_key: "design",
    values: { name: "Design", known_aliases: ["creative"] },
  },
  {
    external_key: "sales",
    values: { name: "Sales", known_aliases: ["gtm"] },
  },
  {
    external_key: "operations",
    values: { name: "Operations", known_aliases: ["ops"] },
  },
];

const LOCATION_SEED_ROWS: readonly LookupSeedRow[] = [
  {
    external_key: "san_francisco_ca",
    values: { name: "San Francisco, CA", known_aliases: ["SF HQ"] },
  },
  {
    external_key: "new_york_ny",
    values: { name: "New York, NY", known_aliases: ["NYC"] },
  },
  {
    external_key: "remote_us",
    values: { name: "Remote (US)", known_aliases: ["Remote - US"] },
  },
  {
    external_key: "chicago_il",
    values: { name: "Chicago, IL", known_aliases: [] },
  },
  {
    external_key: "austin_tx",
    values: { name: "Austin, TX", known_aliases: [] },
  },
];

export const lookup_core_blocks: ModelBlock[] = [
  {
    name: "department",
    kind: "lookup",
    label: "Department",
    fields: {
      // Previously essential.
      ...LOOKUP_MODEL_FIELDS,
      // Previously templated.
      lead: { target_model: "employee", label: "Department Lead" },
      executive: { target_model: "employee", label: "Executive Sponsor" },
    },
    seed_rows: DEPARTMENT_SEED_ROWS,
  },
  {
    name: "location",
    kind: "lookup",
    label: "Location",
    fields: {
      // Previously essential.
      ...LOOKUP_MODEL_FIELDS,
      // Previously templated.
      country: { type: "iso_country", label: "Country" },
      geography: { target_model: "geography", label: "Geo / Region" },
      comp_zone: { target_model: "comp_zone", label: "Compensation Zone" },
    },
    seed_rows: LOCATION_SEED_ROWS,
  },
  {
    name: "pnl_category",
    kind: "lookup",
    label: "P&L Category",
    fields: {
      // Previously essential.
      ...LOOKUP_MODEL_FIELDS,
    },
    seed_rows: PNL_CATEGORY_SEED_ROWS,
  },
];

export const department_import_identity_policy = {
  modelId: "department",
  rungs: [
    { fieldId: "name", kind: "name" },
    { fieldId: "name", aliasFieldId: "known_aliases", kind: "alias" },
  ],
} as const satisfies ImportIdentityPolicy;

export const location_import_identity_policy = {
  modelId: "location",
  rungs: [
    { fieldId: "name", kind: "name" },
    { fieldId: "name", aliasFieldId: "known_aliases", kind: "alias" },
  ],
} as const satisfies ImportIdentityPolicy;

export const pnl_category_import_identity_policy = {
  modelId: "pnl_category",
  rungs: [
    { fieldId: "name", kind: "name" },
    { fieldId: "name", aliasFieldId: "known_aliases", kind: "alias" },
  ],
} as const satisfies ImportIdentityPolicy;
