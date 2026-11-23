import type { RowVersionWrite, Schema } from "@contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  activeCustomFieldIds,
  schemaWithCustomFields,
  splitCustomFieldsFromWrites,
} from "../index";

const schema: Schema = {
  app_id: "hc",
  customer_id: "demo",
  version: "1",
  models: [
    {
      id: "employee",
      kind: "entity",
      label: "Employee",
      fields: [{ id: "name", label: "Name", type: "text", required: true }],
    },
  ],
  custom_fields: [
    {
      id: "employee_level_definition",
      model_id: "employee",
      field_id: "employee_level",
      label: "Employee level",
      type: "enum",
      option_set: [{ id: "l4", label: "L4" }],
    },
    {
      id: "archived_definition",
      model_id: "employee",
      field_id: "old_field",
      label: "Old field",
      type: "text",
      archived_at: "2026-01-01T00:00:00Z",
    },
  ],
  change_types: [],
};

describe("editable-grid custom-field projection", () => {
  it("adds only active custom definitions to the temporary grid schema", () => {
    const projected = schemaWithCustomFields(schema);
    expect(projected.models[0]?.fields.map(({ id }) => id)).toEqual(["name", "employee_level"]);
  });

  it("splits projected custom values into the kernel custom_fields wire member", () => {
    const writes: RowVersionWrite[] = [
      {
        model_id: "employee",
        new_record_id: "00000000-0000-4000-8000-000000000001",
        effective_start: "2026-08-11",
        custom_fields: [{ field_id: "existing_note", type: "text", value: "keep me" }],
        values: {
          name: { type: "text", value: "Ada" },
          employee_level: { type: "enum", value: "l4" },
        },
      },
    ];

    expect(splitCustomFieldsFromWrites(writes, schema)).toEqual([
      {
        model_id: "employee",
        new_record_id: "00000000-0000-4000-8000-000000000001",
        effective_start: "2026-08-11",
        values: { name: { type: "text", value: "Ada" } },
        custom_fields: [
          { field_id: "existing_note", type: "text", value: "keep me" },
          { field_id: "employee_level", type: "enum", value: "l4" },
        ],
      },
    ]);
  });

  it("never lets a custom definition shadow a declared field of the same id", () => {
    const shadowing: Schema = {
      ...schema,
      custom_fields: [
        ...(schema.custom_fields ?? []),
        {
          id: "name_definition",
          model_id: "employee",
          field_id: "name",
          label: "Name",
          type: "text",
        },
      ],
    };
    expect(schemaWithCustomFields(shadowing).models[0]?.fields.map(({ id }) => id)).toEqual([
      "name",
      "employee_level",
    ]);
    expect([...activeCustomFieldIds(shadowing, "employee")]).toEqual(["employee_level"]);
    const [write] = splitCustomFieldsFromWrites(
      [
        {
          model_id: "employee",
          record_key: { type: "record_id", value: "r-1" },
          effective_start: "2026-08-11",
          values: { name: { type: "text", value: "Ada" } },
          clear_fields: ["name"],
        },
      ],
      shadowing,
    );
    expect(write).toMatchObject({ values: { name: { type: "text", value: "Ada" } } });
    expect(write).not.toHaveProperty("custom_fields");
  });
});
