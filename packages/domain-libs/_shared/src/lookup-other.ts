import type { ImportIdentityPolicy, LookupSeedRow, ModelBlock } from "./_types";
import { LOOKUP_MODEL_FIELDS } from "./lookup-helpers";

const BUSINESS_UNIT_SEED_ROWS: readonly LookupSeedRow[] = [
  {
    external_key: "product_engineering",
    values: {
      name: "Product & Engineering",
      known_aliases: [],
    },
  },
  {
    external_key: "go_to_market",
    values: { name: "Go To Market", known_aliases: ["GTM"] },
  },
  {
    external_key: "operations",
    values: { name: "Operations", known_aliases: ["Ops"] },
  },
  {
    external_key: "core_product",
    values: { name: "Core Product", known_aliases: [] },
  },
  {
    external_key: "platform",
    values: { name: "Platform", known_aliases: [] },
  },
  {
    external_key: "enterprise",
    values: { name: "Enterprise", known_aliases: [] },
  },
  { external_key: "smb", values: { name: "SMB", known_aliases: [] } },
  {
    external_key: "corporate",
    values: { name: "Corporate", known_aliases: [] },
  },
  {
    external_key: "growth",
    values: { name: "Growth", known_aliases: [] },
  },
  {
    external_key: "infrastructure",
    values: {
      name: "Infrastructure",
      known_aliases: [],
    },
  },
];

export const lookup_other_blocks: ModelBlock[] = [
  {
    name: "business_unit",
    kind: "lookup",
    label: "Business Unit",
    fields: {
      // Previously essential.
      ...LOOKUP_MODEL_FIELDS,
    },
    seed_rows: BUSINESS_UNIT_SEED_ROWS,
  },
];

export const business_unit_import_identity_policy = {
  modelId: "business_unit",
  rungs: [
    { fieldId: "name", kind: "name" },
    { fieldId: "name", aliasFieldId: "known_aliases", kind: "alias" },
  ],
} as const satisfies ImportIdentityPolicy;

export const lookup_geography_blocks: ModelBlock[] = [
  {
    name: "geography",
    kind: "lookup",
    label: "Geo / Region",
    fields: {
      // Previously essential.
      ...LOOKUP_MODEL_FIELDS,
    },
  },
];
