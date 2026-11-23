import type { ModelBlock } from "@domain-libs/_shared";

/** Kernel record versions are the only effective-period authority. */
export const model_exchange_rate_blocks: ModelBlock[] = [
  {
    name: "exchange_rate",
    kind: "entity",
    label: "Exchange Rate",
    fields: {
      source_currency: { type: "iso_currency", label: "Source Currency" },
      target_currency: { type: "iso_currency", label: "Target Currency" },
      rate: {
        type: "number",
        label: "Rate",
        notes:
          "Positive target units per source unit. Null on a custom version returns the pair to automatic rates. Write through the currency-rate adapter, which validates this invariant.",
      },
      origin: {
        type: "enum",
        label: "Origin",
        option_set: [
          { id: "custom", label: "Custom", aliases: [] },
          { id: "frankfurter", label: "Frankfurter", aliases: [] },
        ],
      },
      observation_date: {
        type: "date",
        label: "Observation Date",
        notes: "Optional provider observation provenance, distinct from the effective date.",
      },
    },
  },
];
