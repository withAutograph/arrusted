import { Button } from "../components/Button";
import { Checkbox, FieldFrame, Select, TextArea, TextField } from "../components/FormControls";
import type { CompositionSpec } from "./spec";
import { coerceSchemaFormValue } from "./SchemaForm.helpers";

export type SchemaFormValue = string | number | boolean | null;

export type SchemaFormOptionSpec = {
  value: string;
  label: string;
  disabled?: boolean;
};

export type SchemaFormFieldSpec = {
  id: string;
  label: string;
  control: "text" | "textarea" | "select" | "checkbox" | "date" | "number";
  value?: SchemaFormValue;
  previousValue?: SchemaFormValue;
  required?: boolean;
  placeholder?: string;
  helper?: string;
  error?: string;
  previousValueLabel?: string;
  disabled?: boolean;
  hidden?: boolean;
  options?: SchemaFormOptionSpec[];
};

export type SchemaFormSpec = {
  fields: SchemaFormFieldSpec[];
  submitLabel?: string;
  resetLabel?: string;
  layout?: "stack" | "grid";
  emptyLabel?: string;
  previousLabel?: string;
  revertLabel?: string;
  emptyValueLabel?: string;
  trueValueLabel?: string;
  falseValueLabel?: string;
};

export type SchemaFormProps = {
  spec: CompositionSpec<"schema_form", SchemaFormSpec>;
  onFieldChange?: (fieldId: string, value: SchemaFormValue) => void;
  onFieldRevert?: (fieldId: string, previousValue: SchemaFormValue) => void;
  onSubmit?: () => void;
  onReset?: () => void;
};

export function SchemaFormComposition(props: SchemaFormProps) {
  const {
    fields,
    submitLabel,
    resetLabel,
    layout = "stack",
    emptyLabel,
    previousLabel,
    revertLabel,
    emptyValueLabel,
    trueValueLabel,
    falseValueLabel,
  } = props.spec.config;
  const visibleFields = fields.filter((field) => !field.hidden);

  if (visibleFields.length === 0) {
    return (
      <div className="rounded-[var(--radius-panel)] border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] p-[var(--space-6)] text-center text-[length:var(--text-body)] text-[var(--color-text-muted)]">
        {emptyLabel}
      </div>
    );
  }

  return (
    <form
      className="flex flex-col gap-[var(--space-4)]"
      onSubmit={(event) => {
        event.preventDefault();
        props.onSubmit?.();
      }}
    >
      <div
        className="grid gap-[var(--space-4)]"
        style={{
          gridTemplateColumns:
            layout === "grid"
              ? "repeat(auto-fit, minmax(var(--size-form-column-min), 1fr))"
              : "1fr",
        }}
      >
        {visibleFields.map((field) => (
          <SchemaFormField
            key={field.id}
            field={field}
            onFieldChange={props.onFieldChange}
            onFieldRevert={props.onFieldRevert}
            previousLabel={previousLabel}
            revertLabel={revertLabel}
            emptyValueLabel={emptyValueLabel}
            trueValueLabel={trueValueLabel}
            falseValueLabel={falseValueLabel}
          />
        ))}
      </div>
      {submitLabel || resetLabel ? (
        <div className="flex flex-wrap items-center gap-[var(--space-2)]">
          {submitLabel ? (
            <Button intent="primary" type="submit">
              {submitLabel}
            </Button>
          ) : null}
          {resetLabel ? (
            <Button type="button" onClick={props.onReset}>
              {resetLabel}
            </Button>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}

function SchemaFormField(props: {
  field: SchemaFormFieldSpec;
  onFieldChange?: (fieldId: string, value: SchemaFormValue) => void;
  onFieldRevert?: (fieldId: string, previousValue: SchemaFormValue) => void;
  previousLabel?: string;
  revertLabel?: string;
  emptyValueLabel?: string;
  trueValueLabel?: string;
  falseValueLabel?: string;
}) {
  const {
    field,
    onFieldChange,
    onFieldRevert,
    previousLabel,
    revertLabel,
    emptyValueLabel,
    trueValueLabel,
    falseValueLabel,
  } = props;

  if (field.control === "checkbox") {
    return (
      <div className="flex flex-col gap-[var(--space-1)]">
        <div className="flex flex-col gap-[var(--space-1)]">
          <Checkbox
            checked={field.value === true}
            disabled={field.disabled}
            label={field.label}
            onCheckedChange={(checked) => onFieldChange?.(field.id, checked)}
          />
          <PreviousValue
            field={field}
            onFieldRevert={onFieldRevert}
            previousLabel={previousLabel}
            revertLabel={revertLabel}
            emptyValueLabel={emptyValueLabel}
            trueValueLabel={trueValueLabel}
            falseValueLabel={falseValueLabel}
          />
        </div>
        {field.error ? (
          <span className="text-[length:var(--text-caption)] text-[var(--color-status-danger)]">
            {field.error}
          </span>
        ) : field.helper ? (
          <span className="text-[length:var(--text-caption)] text-[var(--color-text-muted)]">
            {field.helper}
          </span>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-[var(--space-1)]">
      <FieldFrame
        label={field.label}
        helper={field.helper}
        error={field.error}
        required={field.required}
      >
        {renderControl(field, onFieldChange)}
      </FieldFrame>
      <PreviousValue
        field={field}
        onFieldRevert={onFieldRevert}
        previousLabel={previousLabel}
        revertLabel={revertLabel}
        emptyValueLabel={emptyValueLabel}
        trueValueLabel={trueValueLabel}
        falseValueLabel={falseValueLabel}
      />
    </div>
  );
}

function PreviousValue(props: {
  field: SchemaFormFieldSpec;
  onFieldRevert?: (fieldId: string, previousValue: SchemaFormValue) => void;
  previousLabel?: string;
  revertLabel?: string;
  emptyValueLabel?: string;
  trueValueLabel?: string;
  falseValueLabel?: string;
}) {
  const {
    field,
    onFieldRevert,
    previousLabel = "Previous",
    revertLabel = "Revert",
    emptyValueLabel = "Empty",
    trueValueLabel = "Yes",
    falseValueLabel = "No",
  } = props;
  if (field.previousValue === undefined || valuesMatch(field.value, field.previousValue)) {
    return null;
  }
  return (
    <span className="flex flex-wrap items-center gap-[var(--space-2)] text-[length:var(--text-caption)] text-[var(--color-text-muted)]">
      <span>
        {previousLabel}:{" "}
        {field.previousValueLabel ??
          formatSchemaFormValue(field.previousValue, {
            emptyValueLabel,
            trueValueLabel,
            falseValueLabel,
          })}
      </span>
      {onFieldRevert ? (
        <button
          type="button"
          className="text-[var(--color-action-primary)] underline"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onFieldRevert(field.id, field.previousValue as SchemaFormValue);
          }}
        >
          {revertLabel}
        </button>
      ) : null}
    </span>
  );
}

function renderControl(
  field: SchemaFormFieldSpec,
  onFieldChange?: (fieldId: string, value: SchemaFormValue) => void,
) {
  const shared = {
    disabled: field.disabled,
    placeholder: field.placeholder,
  };
  if (field.control === "textarea") {
    return (
      <TextArea
        {...shared}
        value={typeof field.value === "string" ? field.value : ""}
        onValueChange={(value) => onFieldChange?.(field.id, value)}
      />
    );
  }
  if (field.control === "select") {
    return (
      <Select
        disabled={field.disabled}
        value={typeof field.value === "string" ? field.value : ""}
        options={[{ value: "", label: field.placeholder ?? "Select..." }, ...(field.options ?? [])]}
        onValueChange={(value) => onFieldChange?.(field.id, value === "" ? null : value)}
      />
    );
  }
  return (
    <TextField
      {...shared}
      type={field.control === "number" ? "number" : field.control === "date" ? "date" : "text"}
      value={typeof field.value === "string" || typeof field.value === "number" ? field.value : ""}
      onValueChange={(value) => onFieldChange?.(field.id, coerceSchemaFormValue(field, value))}
    />
  );
}

function formatSchemaFormValue(
  value: SchemaFormValue,
  labels: {
    emptyValueLabel: string;
    trueValueLabel: string;
    falseValueLabel: string;
  },
): string {
  if (value === null || value === "") {
    return labels.emptyValueLabel;
  }
  if (typeof value === "boolean") {
    return value ? labels.trueValueLabel : labels.falseValueLabel;
  }
  return String(value);
}

function valuesMatch(
  left: SchemaFormValue | undefined,
  right: SchemaFormValue | undefined,
): boolean {
  return left === right;
}
