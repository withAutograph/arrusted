import { type LookupSeedRow, type ModelBlock } from "@domain-libs/_shared";

export const SUBSCRIPTION_STATUS_SEED_ROWS: readonly LookupSeedRow[] = [
  {
    external_key: "active",
    values: {
      name: "Active",
      sort_order: 1,
      known_aliases: [],
    },
  },
  {
    external_key: "past_due",
    values: {
      name: "Past Due",
      sort_order: 2,
      known_aliases: [],
    },
  },
  {
    external_key: "unpaid",
    values: {
      name: "Unpaid",
      sort_order: 3,
      known_aliases: [],
    },
  },
  {
    external_key: "canceled",
    values: {
      name: "Canceled",
      sort_order: 4,
      known_aliases: [],
    },
  },
  {
    external_key: "incomplete",
    values: {
      name: "Incomplete",
      sort_order: 5,
      known_aliases: [],
    },
  },
  {
    external_key: "incomplete_expired",
    values: {
      name: "Incomplete Expired",
      sort_order: 6,
      known_aliases: [],
    },
  },
  {
    external_key: "trialing",
    values: {
      name: "Trialing",
      sort_order: 7,
      known_aliases: [],
    },
  },
  {
    external_key: "paused",
    values: {
      name: "Paused",
      sort_order: 8,
      known_aliases: [],
    },
  },
];

/**
 * Revenue-domain lookup models.
 *
 * Status and enum lookups used by revenue-domain models.
 */
export const lookup_revenue_blocks: ModelBlock[] = [];
