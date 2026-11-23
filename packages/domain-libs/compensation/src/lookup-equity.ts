import { placeholderEnumField, type ModelBlock } from "@domain-libs/_shared";

export const lookup_equity_blocks: ModelBlock[] = [
  {
    name: "equity_grant",
    kind: "entity",
    label: "Equity Grant",
    fields: {
      // Previously essential.
      id: { type: "text", label: "Grant ID", is_unique: true },
      equity_grant_reason: placeholderEnumField({
        label: "Reason for Equity Grant",
      }),
      equity_grant_type: placeholderEnumField({
        label: "Equity Grant Type",
      }),
      equity_grant_status: placeholderEnumField({
        label: "Equity Grant Status",
      }),
      equity_target_price: placeholderEnumField({
        label: "Equity Target Price",
      }),
      start_date: { type: "date", label: "Vesting Start Date" },
      issuance_date: { type: "date", label: "Issuance Date" },
      end_date: { type: "date", label: "Vesting End Date" },
      number_of_shares: { type: "number", label: "Number of Shares" },
      recipient: { target_model: "employee", label: "Recipient" },
      price_per_share: { type: "number", label: "Purchase Price / Share" },
    },
  },
];
