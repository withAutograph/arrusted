import type { ImportIdentityPolicy, ModelBlock } from "@domain-libs/_shared";

/** Provider-neutral transaction vocabulary; apps choose required fields and workflow. */
export const model_vendor_spend_blocks: ModelBlock[] = [
  {
    name: "vendor_spend_transaction",
    kind: "entity",
    label: "Vendor Spend Transaction",
    fields: {
      source_record_ref: { type: "text", label: "Source Record Ref", is_unique: true },
      source_record_id: { type: "text", label: "Source Record ID" },
      vendor: { target_model: "vendor", label: "Vendor" },
      counterparty_name: { type: "text", label: "Counterparty Name" },
      document_number: { type: "text", label: "Document Number" },
      amount: { type: "number", label: "Transaction Amount" },
      currency_code: { type: "iso_currency", label: "Currency" },
      transaction_date: { type: "date", label: "Transaction Date" },
      status: { type: "text", label: "Status" },
    },
  },
];

export const vendor_import_identity_policy = {
  modelId: "vendor",
  rungs: [
    { fieldId: "name", kind: "name" },
    { fieldId: "name", aliasFieldId: "known_aliases", kind: "alias" },
  ],
} as const satisfies ImportIdentityPolicy;

export const vendor_spend_import_identity_policy = {
  modelId: "vendor_spend_transaction",
  rungs: [{ fieldId: "source_record_ref", kind: "unique" }],
} as const satisfies ImportIdentityPolicy;
