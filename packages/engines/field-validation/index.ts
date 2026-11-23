// Field validation engine.
//
// Pure predicates that take a `FieldValue` (and optionally the surrounding
// row) and return `Ok` or a typed `Invalid` with an error message. Used by
// the editable-grid module to gate buffer entries: if the validate function
// returns Invalid for a commit, the buffer entry is REJECTED (no dirty
// state), and the cell surfaces the error inline.
//
// Living in `engines/` (not `modules/`) means validation rules can be
// composed, unit-tested, and reused outside the React render tree —
// importers, CSV pipelines, server-side validation harnesses, or any
// surface that needs the same rule.
//
// No React imports; no DOM. Tested as pure functions in
// `packages/engines/field-validation/__tests__`.

import type { FieldValue, VisibleRecord } from "@contracts";

export type ValidationOk = { ok: true };
export type ValidationInvalid = { ok: false; message: string };
export type ValidationResult = ValidationOk | ValidationInvalid;

export const VALID: ValidationOk = { ok: true };

export function invalid(message: string): ValidationInvalid {
  return { ok: false, message };
}

// A validator takes the candidate FieldValue (the wrapped commit value) and
// optionally the row context (so cross-field rules can read other fields'
// current values). Accepts `null` so cleared / missing values can flow
// through the same predicate (`required` rejects null; range / length /
// pattern defer to required and pass null silently). Returns synchronous
// result — async validation against the kernel happens server-side at
// apply time and surfaces via ErrorEnvelope.
export type FieldValidator = (
  next: FieldValue | null,
  context: { row?: VisibleRecord; fieldId: string },
) => ValidationResult;

export type FieldValidationRule =
  | { kind: "required"; message?: string }
  | { kind: "text_length"; minLength?: number; maxLength?: number }
  | {
      kind: "range";
      min?: number;
      max?: number;
      /** Non-empty custom invalid-range message. `{value}` is replaced with the parsed numeric value. */
      message?: string;
    }
  | { kind: "date_before"; endFieldId: string; message?: string }
  | { kind: "date_after"; startFieldId: string; message?: string };

export type FieldValidationRuleMap = Readonly<
  Record<string, readonly FieldValidationRule[] | undefined>
>;

// Compose multiple validators into one. Returns the first Invalid; if all
// pass, returns VALID. Order matters — put cheap checks first.
export function combine(...validators: FieldValidator[]): FieldValidator {
  return (next, context) => {
    for (const v of validators) {
      const result = v(next, context);
      if (!result.ok) return result;
    }
    return VALID;
  };
}

export function validatorFromRules(
  rules: readonly FieldValidationRule[] | undefined,
): FieldValidator | undefined {
  if (!rules || rules.length === 0) return undefined;
  return combine(...rules.map(validatorFromRule));
}

function validatorFromRule(rule: FieldValidationRule): FieldValidator {
  switch (rule.kind) {
    case "required":
      return required(rule.message);
    case "text_length":
      return textLength({
        minLength: rule.minLength,
        maxLength: rule.maxLength,
      });
    case "range": {
      const rangeMessage = rule.message;
      return inRange({
        min: rule.min,
        max: rule.max,
        message: rangeMessage ? (n) => rangeMessage.replace("{value}", String(n)) : undefined,
      });
    }
    case "date_before":
      return dateBefore({
        endFieldId: rule.endFieldId,
        message: rule.message,
      });
    case "date_after":
      return dateAfter({
        startFieldId: rule.startFieldId,
        message: rule.message,
      });
    default: {
      const _exhaustive: never = rule;
      return _exhaustive;
    }
  }
}

// ---------- Common rules ----------

// Required: the FieldValue must have a non-empty value. Distinct from null:
// `{ type: "text", value: "" }` is REJECTED (explicit empty), null is
// REJECTED (no value). `{ type: "bool", value: false }` is ACCEPTED (false
// is a valid choice, not absence).
export function required(message = "Required"): FieldValidator {
  return (next) => {
    if (next == null) return invalid(message);
    switch (next.type) {
      case "text":
      case "number":
      case "date":
      case "datetime":
        return next.value.trim().length > 0 ? VALID : invalid(message);
      case "bool":
        // bool always has a value (true or false). Required only catches null.
        return VALID;
      case "relation":
        return (next.value.type === "lookup_or_create" ? next.value.value.label : next.value.value)
          .length > 0
          ? VALID
          : invalid(message);
      case "relation_list":
        return next.value.length > 0 ? VALID : invalid(message);
      case "text_list":
        return next.value.length > 0 ? VALID : invalid(message);
      case "json":
        return next.value != null ? VALID : invalid(message);
      case "enum":
        return next.value.trim().length > 0 ? VALID : invalid(message);
      case "money_rate":
        return next.value.amount.trim().length > 0 ? VALID : invalid(message);
      case "schema_lifecycle":
        return next.value.length > 0 ? VALID : invalid(message);
      default: {
        // Exhaustiveness guard: if a new FieldValue variant is added in
        // `@contracts/wire.generated.ts`, TypeScript fails this assignment
        // and forces this function to grow a case for the new variant.
        // Without the guard, the new variant would silently fall through
        // to a return-undefined and the FieldValidator type would still
        // accept it at the assignment site.
        const _exhaustive: never = next;
        return _exhaustive;
      }
    }
  };
}

// Numeric range: `min` / `max` inclusive. Applies to `number` and
// `money_rate` (uses amount).
export function inRange(opts: {
  min?: number;
  max?: number;
  message?: (n: number) => string;
}): FieldValidator {
  const { min, max, message } = opts;
  return (next) => {
    let n: number;
    if (next == null) return VALID; // required is a separate rule
    if (next.type === "number") {
      n = Number(next.value);
    } else if (next.type === "money_rate") {
      n = Number(next.value.amount);
    } else {
      return VALID;
    }
    if (Number.isNaN(n)) return invalid("Not a number");
    if (min != null && n < min) {
      return invalid(message ? message(n) : `Must be at least ${min}`);
    }
    if (max != null && n > max) {
      return invalid(message ? message(n) : `Must be at most ${max}`);
    }
    return VALID;
  };
}

// Text length: `minLength` / `maxLength` inclusive. Measures the trimmed
// length so a user can't satisfy `minLength: 2` by typing "A " (one letter
// + trailing whitespace). `required()` already trims via the same rule;
// keeping these in sync prevents the inconsistency where `combine(required,
// textLength)` would accept whitespace-padded inputs.
export function textLength(opts: { minLength?: number; maxLength?: number }): FieldValidator {
  const { minLength, maxLength } = opts;
  return (next) => {
    if (next == null || next.type !== "text") return VALID;
    const len = next.value.trim().length;
    if (minLength != null && len < minLength) {
      return invalid(`Must be at least ${minLength} characters`);
    }
    if (maxLength != null && len > maxLength) {
      return invalid(`Must be at most ${maxLength} characters`);
    }
    return VALID;
  };
}

// Pattern: regex match. Applies to `text`. Resets `lastIndex` before each
// test so callers passing a regex with `g` / `y` flags get deterministic
// behavior across repeated validations on the same field — without the
// reset, every other call would silently start from the wrong position
// and produce different results for identical inputs.
export function pattern(opts: { regex: RegExp; message: string }): FieldValidator {
  return (next) => {
    if (next == null || next.type !== "text") return VALID;
    opts.regex.lastIndex = 0;
    return opts.regex.test(next.value) ? VALID : invalid(opts.message);
  };
}

// Cross-field date range: `next` is the start; the field id of the end is
// passed in. The validator reads the end value from the row context. If end
// exists and is BEFORE next, the start is invalid. Mirror predicate for end.
export function dateBefore(opts: { endFieldId: string; message?: string }): FieldValidator {
  return (next, ctx) => {
    if (next == null || next.type !== "date" || !next.value) return VALID;
    const endFv = ctx.row?.values[opts.endFieldId];
    if (!endFv || endFv.type !== "date" || !endFv.value) return VALID;
    if (next.value > endFv.value) {
      return invalid(opts.message ?? "Start must be on or before end");
    }
    return VALID;
  };
}

export function dateAfter(opts: { startFieldId: string; message?: string }): FieldValidator {
  return (next, ctx) => {
    if (next == null || next.type !== "date" || !next.value) return VALID;
    const startFv = ctx.row?.values[opts.startFieldId];
    if (!startFv || startFv.type !== "date" || !startFv.value) return VALID;
    if (next.value < startFv.value) {
      return invalid(opts.message ?? "End must be on or after start");
    }
    return VALID;
  };
}
