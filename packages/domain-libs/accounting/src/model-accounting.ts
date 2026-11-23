import type { ModelBlock } from "@domain-libs/_shared";

export const model_accounting_blocks: ModelBlock[] = [
  {
    name: "chart_account",
    kind: "entity",
    label: "Chart Account",
    fields: {
      id: { type: "text", label: "Chart Account ID", is_unique: true },
      code: { type: "text", label: "Account Code" },
      name: { type: "text", label: "Account Name" },
      parent: { target_model: "chart_account", label: "Parent Chart Account" },
      account_type: { type: "text", label: "Source Account Type" },
      known_aliases: { type: "text_list", label: "Known Aliases" },
    },
  },
];
