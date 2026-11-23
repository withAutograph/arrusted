import type { DataDefinition } from "../../generated-app-runtime/data";
export const definition = {
  formatVersion: 1,
  schemaVersion: "quickbooks-test-v1",
  models: [
    {
      id: "supplier",
      name: "supplier",
      fields: [
        { id: "name", name: "name", type: "text", required: true, readOnly: false },
        {
          id: "status",
          name: "status",
          type: "enum",
          option_set: [{ id: "active" }, { id: "inactive" }],
          required: true,
          readOnly: false,
        },
        { id: "entity", name: "entity", type: "text", required: false, readOnly: false },
      ],
      relations: [],
    },
    {
      id: "payable",
      name: "payable",
      fields: [
        {
          id: "vendor",
          name: "vendor",
          type: "relation",
          target_model: "supplier",
          required: true,
          readOnly: false,
        },
        { id: "amount", name: "amount", type: "number", required: true, readOnly: false },
        { id: "currency", name: "currency", type: "iso_currency", required: true, readOnly: false },
        { id: "date", name: "date", type: "date", required: true, readOnly: false },
        { id: "updated", name: "updated", type: "datetime", required: true, readOnly: false },
        {
          id: "kind",
          name: "kind",
          type: "enum",
          option_set: [{ id: "bill" }, { id: "credit" }],
          required: true,
          readOnly: false,
        },
        { id: "open", name: "open", type: "number", required: false, readOnly: false },
        { id: "due", name: "due", type: "date", required: false, readOnly: false },
      ],
      relations: [],
    },
  ],
} as const satisfies DataDefinition;
