import type { FieldValidationRuleMap } from "../../../engines/field-validation/index";

export const MONEY_RANGE_RULES = [
  {
    kind: "range",
    min: 0,
    max: 10_000_000,
    message: "Amount {value} is outside the expected range",
  },
] as const;

export const POSITION_FIELD_VALIDATION_RULES = {
  name: [
    { kind: "required", message: "Position name is required" },
    { kind: "text_length", minLength: 2 },
  ],
  position_status: [{ kind: "required", message: "Status is required" }],
  department: [{ kind: "required", message: "Department is required" }],
  start_date: [
    {
      kind: "date_before",
      endFieldId: "end_date",
      message: "Start date must be on or before end date",
    },
  ],
  end_date: [
    {
      kind: "date_after",
      startFieldId: "start_date",
      message: "End date must be on or after start date",
    },
  ],
  base_salary: [
    {
      kind: "range",
      min: 0,
      max: 10_000_000,
      message: "Salary {value} is outside the expected range",
    },
  ],
  target_bonus: MONEY_RANGE_RULES,
  target_commission: MONEY_RANGE_RULES,
  annual_equity_value: MONEY_RANGE_RULES,
  benefits_actual: MONEY_RANGE_RULES,
  taxes_actual: MONEY_RANGE_RULES,
} satisfies FieldValidationRuleMap;
