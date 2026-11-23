import { CompositionRegistry } from "../../compositions/spec";
import { coerceSchemaFormValue } from "../../compositions/SchemaForm.helpers";
import { validateSchemaFormSpec } from "../../compositions/SchemaForm.validation";
import { schemaFormStory } from "../composition-fixtures";

import nodeAssert from "node:assert/strict";
import { describe, it } from "vite-plus/test";

function assert(condition: unknown, message: string): asserts condition {
  nodeAssert(condition, message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  nodeAssert.equal(actual, expected, message);
}

function assertThrows(fn: () => void, expectedMessage: string, message: string) {
  nodeAssert.throws(
    fn,
    (error: unknown) => {
      const text = error instanceof Error ? error.message : String(error);
      assert(
        text.includes(expectedMessage),
        message + ": expected error containing " + expectedMessage + ", got " + text,
      );
      return true;
    },
    message,
  );
}

function testCompositionTrustCaps() {
  const registry = new CompositionRegistry();
  registry.register({
    type: "data_table",
    description: "test renderer",
    validate: (value) => value,
    render: () => null,
  });

  registry.render(
    {
      type: "data_table",
      config: { rows: Array.from({ length: 1001 }, (_, index) => index) },
    },
    "app",
  );

  registry.render(
    {
      type: "data_table",
      config: { rows: Array.from({ length: 100 }, (_, index) => index) },
    },
    "agent",
  );

  assertThrows(
    () =>
      registry.render(
        {
          type: "data_table",
          config: { rows: Array.from({ length: 101 }, (_, index) => index) },
        },
        "agent",
      ),
    "maximum array length",
    "agent specs cap arrays",
  );
  assertThrows(
    () =>
      registry.render(
        {
          type: "data_table",
          title: "x".repeat(10_001),
          config: {},
        },
        "agent",
      ),
    "maximum string length",
    "agent specs cap strings across the full spec",
  );
  assertThrows(
    () =>
      registry.render(
        {
          type: "data_table",
          config: Object.fromEntries(
            Array.from({ length: 101 }, (_, index) => [`k${index}`, index]),
          ),
        },
        "saved_view",
      ),
    "maximum object key count",
    "saved view specs cap object breadth",
  );
}

function testSchemaFormCompositionValidation() {
  validateSchemaFormSpec(schemaFormStory.config);

  const validFields = [
    { control: "text", value: "alpha", previousValue: "beta" },
    { control: "textarea", value: "alpha", previousValue: "beta" },
    {
      control: "select",
      value: "enabled",
      previousValue: "disabled",
      options: [
        { value: "enabled", label: "Enabled" },
        { value: "disabled", label: "Disabled" },
      ],
    },
    { control: "checkbox", value: true, previousValue: false },
    { control: "date", value: "2026-07-01", previousValue: "2026-06-01" },
    { control: "number", value: 42, previousValue: 21 },
  ];

  validateSchemaFormSpec({
    fields: validFields.map((field, index) => ({
      id: `field_${index}`,
      label: `Field ${index}`,
      ...field,
    })),
  });
  validateSchemaFormSpec({
    fields: validFields.map((field, index) => ({
      id: `empty_${index}`,
      label: `Empty ${index}`,
      ...field,
      value: null,
      previousValue: null,
    })),
  });
  assertEqual(
    coerceSchemaFormValue({ id: "date", label: "Date", control: "date" }, ""),
    null,
    "cleared date inputs round-trip as null",
  );
  assertEqual(
    coerceSchemaFormValue({ id: "number", label: "Number", control: "number" }, ""),
    null,
    "cleared number inputs round-trip as null",
  );
  assertEqual(
    coerceSchemaFormValue({ id: "text", label: "Text", control: "text" }, ""),
    "",
    "cleared text inputs remain empty strings",
  );

  const invalidCases = [
    {
      label: "text rejects boolean value",
      field: { control: "text", value: true },
      message: "must be a string for text controls",
    },
    {
      label: "textarea rejects numeric previousValue",
      field: { control: "textarea", previousValue: 12 },
      message: "must be a string for textarea controls",
    },
    {
      label: "select rejects missing option",
      field: {
        control: "select",
        value: "missing",
        options: [{ value: "enabled", label: "Enabled" }],
      },
      message: "must match one of the configured select options",
    },
    {
      label: "select rejects numeric previousValue",
      field: {
        control: "select",
        previousValue: 5,
        options: [{ value: "enabled", label: "Enabled" }],
      },
      message: "must be a string for select controls",
    },
    {
      label: "checkbox rejects string value",
      field: { control: "checkbox", value: "true" },
      message: "must be a boolean for checkbox controls",
    },
    {
      label: "date rejects numeric value",
      field: { control: "date", value: 12345 },
      message: "must be a YYYY-MM-DD string for date controls",
    },
    {
      label: "date rejects malformed previousValue",
      field: { control: "date", previousValue: "07/01/2026" },
      message: "must be a YYYY-MM-DD string for date controls",
    },
    {
      label: "number rejects string value",
      field: { control: "number", value: "42" },
      message: "must be a finite number for number controls",
    },
    {
      label: "number rejects non-finite previousValue",
      field: { control: "number", previousValue: Number.POSITIVE_INFINITY },
      message: "must be a finite number for number controls",
    },
  ];

  for (const invalidCase of invalidCases) {
    assertThrows(
      () =>
        validateSchemaFormSpec({
          fields: [
            {
              id: "field",
              label: "Field",
              ...invalidCase.field,
            },
          ],
        }),
      invalidCase.message,
      invalidCase.label,
    );
  }
}

describe("form compositions", () => {
  it("validates composition trust caps", () => {
    testCompositionTrustCaps();
  });

  it("validates schema form composition specs", () => {
    testSchemaFormCompositionValidation();
  });
});
