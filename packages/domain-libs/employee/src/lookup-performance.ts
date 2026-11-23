import { type LookupSeedRow, type ModelBlock } from "@domain-libs/_shared";

export const PERFORMANCE_RATING_SEED_ROWS: readonly LookupSeedRow[] = [
  {
    external_key: "exceeds",
    values: {
      name: "Exceeds Expectations",
      known_aliases: ["exceeds", "exceeds_expectations"],
    },
  },
  {
    external_key: "meets",
    values: {
      name: "Meets Expectations",
      known_aliases: ["meets", "meets_expectations"],
    },
  },
  {
    external_key: "needs_improvement",
    values: {
      name: "Needs Improvement",
      known_aliases: ["needs_improvement", "needs-improvement"],
    },
  },
  {
    external_key: "unsatisfactory",
    values: {
      name: "Unsatisfactory",
      known_aliases: ["unsatisfactory"],
    },
  },
];

export const lookup_performance_blocks: ModelBlock[] = [];
