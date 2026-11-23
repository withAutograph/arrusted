import { optionalString, requireArray, requireObject, requireString } from "./spec";
import type {
  SchemaFormFieldSpec,
  SchemaFormOptionSpec,
  SchemaFormSpec,
  SchemaFormValue,
} from "./SchemaForm";

export function validateSchemaFormSpec(value: unknown): SchemaFormSpec {
  const object = requireObject(value, "schema_form.config");
  const fields = requireArray(object.fields, "schema_form.fields", (item, index) => {
    const field = requireObject(item, `schema_form.fields[${index}]`);
    const control = requireSchemaFormControl(field.control, `schema_form.fields[${index}].control`);
    const options = validateSchemaFormOptions(field.options, control, index);
    return {
      id: requireString(field.id, `schema_form.fields[${index}].id`),
      label: requireString(field.label, `schema_form.fields[${index}].label`),
      control,
      value: validateSchemaFormFieldValue(
        control,
        field.value,
        options,
        `schema_form.fields[${index}].value`,
      ),
      previousValue: validateSchemaFormFieldValue(
        control,
        field.previousValue,
        options,
        `schema_form.fields[${index}].previousValue`,
      ),
      required: field.required === true,
      placeholder: optionalString(field.placeholder, `schema_form.fields[${index}].placeholder`),
      helper: optionalString(field.helper, `schema_form.fields[${index}].helper`),
      error: optionalString(field.error, `schema_form.fields[${index}].error`),
      previousValueLabel: optionalString(
        field.previousValueLabel,
        `schema_form.fields[${index}].previousValueLabel`,
      ),
      disabled: field.disabled === true,
      hidden: field.hidden === true,
      options,
    };
  });

  return {
    fields,
    submitLabel: optionalString(object.submitLabel, "schema_form.submitLabel"),
    resetLabel: optionalString(object.resetLabel, "schema_form.resetLabel"),
    layout: object.layout === "grid" ? "grid" : "stack",
    emptyLabel: typeof object.emptyLabel === "string" ? object.emptyLabel : "No fields.",
    previousLabel: optionalString(object.previousLabel, "schema_form.previousLabel"),
    revertLabel: optionalString(object.revertLabel, "schema_form.revertLabel"),
    emptyValueLabel: optionalString(object.emptyValueLabel, "schema_form.emptyValueLabel"),
    trueValueLabel: optionalString(object.trueValueLabel, "schema_form.trueValueLabel"),
    falseValueLabel: optionalString(object.falseValueLabel, "schema_form.falseValueLabel"),
  };
}

function validateSchemaFormOptions(
  value: unknown,
  control: SchemaFormFieldSpec["control"],
  fieldIndex: number,
): SchemaFormOptionSpec[] | undefined {
  if (control !== "select") {
    if (value !== undefined) {
      throw new Error(
        `schema_form.fields[${fieldIndex}].options is only valid for select controls`,
      );
    }
    return undefined;
  }
  const options = requireArray(
    value,
    `schema_form.fields[${fieldIndex}].options`,
    (option, optionIndex) => {
      const optionObject = requireObject(
        option,
        `schema_form.fields[${fieldIndex}].options[${optionIndex}]`,
      );
      return {
        value: requireString(
          optionObject.value,
          `schema_form.fields[${fieldIndex}].options[${optionIndex}].value`,
        ),
        label: requireString(
          optionObject.label,
          `schema_form.fields[${fieldIndex}].options[${optionIndex}].label`,
        ),
        disabled: optionObject.disabled === true,
      };
    },
  );
  if (options.length === 0) {
    throw new Error(`schema_form.fields[${fieldIndex}].options must not be empty`);
  }
  return options;
}

function requireSchemaFormControl(value: unknown, name: string): SchemaFormFieldSpec["control"] {
  if (
    value === "text" ||
    value === "textarea" ||
    value === "select" ||
    value === "checkbox" ||
    value === "date" ||
    value === "number"
  ) {
    return value;
  }
  throw new Error(`${name} must be a supported schema form control`);
}

function validateSchemaFormFieldValue(
  control: SchemaFormFieldSpec["control"],
  value: unknown,
  options: SchemaFormOptionSpec[] | undefined,
  name: string,
): SchemaFormValue | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return value;
  }
  if (control === "text" || control === "textarea") {
    if (typeof value !== "string") {
      throw new Error(`${name} must be a string for ${control} controls`);
    }
    return value;
  }
  if (control === "select") {
    if (typeof value !== "string") {
      throw new Error(`${name} must be a string for select controls`);
    }
    if (!options?.some((option) => option.value === value)) {
      throw new Error(`${name} must match one of the configured select options`);
    }
    return value;
  }
  if (control === "checkbox") {
    if (typeof value !== "boolean") {
      throw new Error(`${name} must be a boolean for checkbox controls`);
    }
    return value;
  }
  if (control === "date") {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new Error(`${name} must be a YYYY-MM-DD string for date controls`);
    }
    return value;
  }
  if (control === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`${name} must be a finite number for number controls`);
    }
    return value;
  }
  throw new Error(`${name} uses an unsupported schema form control`);
}
