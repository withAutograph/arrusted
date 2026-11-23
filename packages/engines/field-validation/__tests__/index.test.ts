import {
  combine,
  dateAfter,
  dateBefore,
  inRange,
  invalid,
  pattern,
  required,
  textLength,
  VALID,
  validatorFromRules,
} from "../index";
import type { VisibleRecord } from "../../../contracts/index";

import nodeAssert from "node:assert/strict";
import { describe, it } from "vite-plus/test";

function assert(condition: unknown, message: string): asserts condition {
  nodeAssert(condition, message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  nodeAssert.equal(actual, expected, message);
}

// Field validation engine probes. The library's `fieldSetter` factory uses
// these predicates to GATE buffer entries — invalid commits never dirty.
// These probes guard the rule semantics (required, range, length, pattern,
// date ordering, combine short-circuit).
function testFieldValidation() {
  const ctx = { fieldId: "title" };

  // required across variants
  assert(required()({ type: "text", value: "x" }, ctx).ok, "required: text non-empty");
  assert(!required()({ type: "text", value: "" }, ctx).ok, "required: text empty rejected");
  assert(!required()({ type: "text", value: "   " }, ctx).ok, "required: text whitespace rejected");
  assert(!required()(null, ctx).ok, "required: null rejected");
  assert(
    required()({ type: "bool", value: false }, ctx).ok,
    "required: bool false is valid (presence, not truthiness)",
  );
  assert(required()({ type: "bool", value: true }, ctx).ok, "required: bool true valid");
  assert(
    required()({ type: "relation", value: { type: "record_id", value: "uuid-1" } }, ctx).ok,
    "required: relation with non-empty value passes",
  );
  assert(
    !required()({ type: "relation", value: { type: "record_id", value: "" } }, ctx).ok,
    "required: relation with empty value rejected",
  );

  // inRange numeric
  const range = inRange({ min: 0, max: 100 });
  assert(range({ type: "number", value: "50" }, ctx).ok, "inRange: 50 in [0,100]");
  assert(!range({ type: "number", value: "-1" }, ctx).ok, "inRange: -1 below min");
  assert(!range({ type: "number", value: "101" }, ctx).ok, "inRange: 101 above max");
  assert(!range({ type: "number", value: "abc" }, ctx).ok, "inRange: NaN rejected");
  assert(range(null, ctx).ok, "inRange: null deferred to required");
  assert(
    range({ type: "money_rate", value: { amount: "75", currency: "USD", period: "annual" } }, ctx)
      .ok,
    "inRange: money_rate amount inside range",
  );

  // textLength
  const len = textLength({ minLength: 2, maxLength: 5 });
  assert(len({ type: "text", value: "abc" }, ctx).ok, "textLength: abc in [2,5]");
  assert(!len({ type: "text", value: "a" }, ctx).ok, "textLength: too short");
  assert(!len({ type: "text", value: "abcdef" }, ctx).ok, "textLength: too long");
  // Trim consistency with required(): "A " (one letter + trailing space)
  // must NOT satisfy minLength: 2 — both required and textLength now use
  // trimmed length so the validators stay aligned under combine().
  assert(
    !len({ type: "text", value: "A " }, ctx).ok,
    "textLength: trims before measuring (consistency with required)",
  );

  // pattern
  const slug = pattern({ regex: /^[a-z][a-z0-9-]*$/, message: "must be a slug" });
  assert(slug({ type: "text", value: "hr-positions-q3" }, ctx).ok, "pattern: slug ok");
  assert(!slug({ type: "text", value: "Bad Slug" }, ctx).ok, "pattern: slug with space rejected");

  // combine short-circuit: first invalid wins
  const composed = combine(required("must"), textLength({ minLength: 3 }));
  const r = composed({ type: "text", value: "" }, ctx);
  assertEqual(r.ok, false, "combine: empty rejected by required");
  if (!r.ok) assertEqual(r.message, "must", "combine: returns required's message");
  assert(!composed({ type: "text", value: "ab" }, ctx).ok, "combine: short rejected by textLength");
  assert(composed({ type: "text", value: "abc" }, ctx).ok, "combine: passes both");

  const compiled = validatorFromRules([
    { kind: "required", message: "Title is required" },
    { kind: "text_length", minLength: 3 },
  ]);
  assert(compiled != null, "validatorFromRules: rules compile");
  assert(
    !compiled({ type: "text", value: "" }, ctx).ok,
    "validatorFromRules: required rule applies",
  );
  assert(
    !compiled({ type: "text", value: "ab" }, ctx).ok,
    "validatorFromRules: text length rule applies",
  );
  assert(
    compiled({ type: "text", value: "abc" }, ctx).ok,
    "validatorFromRules: composed rules pass",
  );

  const compiledMoneyRange = validatorFromRules([
    {
      kind: "range",
      min: 0,
      max: 100,
      message: "Amount {value} is outside the expected range",
    },
  ]);
  assert(compiledMoneyRange != null, "validatorFromRules: range rule compiles");
  const rangeResult = compiledMoneyRange(
    { type: "money_rate", value: { amount: "101", currency: "USD", period: "annual" } },
    ctx,
  );
  assertEqual(rangeResult.ok, false, "validatorFromRules: range rejects out of bounds");
  if (!rangeResult.ok) {
    assertEqual(
      rangeResult.message,
      "Amount 101 is outside the expected range",
      "validatorFromRules: range message template uses parsed value",
    );
  }
  const compiledBlankRangeMessage = validatorFromRules([{ kind: "range", min: 0, message: "" }]);
  assert(
    compiledBlankRangeMessage != null,
    "validatorFromRules: blank range message rule compiles",
  );
  const blankMessageResult = compiledBlankRangeMessage({ type: "number", value: "-1" }, ctx);
  assertEqual(
    blankMessageResult.ok,
    false,
    "validatorFromRules: blank range message still rejects out of bounds",
  );
  if (!blankMessageResult.ok) {
    assertEqual(
      blankMessageResult.message,
      "Must be at least 0",
      "validatorFromRules: blank range message falls back to default",
    );
  }

  // dateBefore / dateAfter cross-field
  const row: VisibleRecord = {
    record_id: "rec-1",
    effective_start: "2026-01-01",
    custom_fields: [],
    values: {
      start_date: { type: "date", value: "2026-01-01" },
      end_date: { type: "date", value: "2026-06-30" },
    },
  };
  const startBeforeEnd = dateBefore({ endFieldId: "end_date" });
  assert(
    startBeforeEnd({ type: "date", value: "2026-03-01" }, { row, fieldId: "start_date" }).ok,
    "dateBefore: start before end ok",
  );
  assert(
    !startBeforeEnd({ type: "date", value: "2026-12-01" }, { row, fieldId: "start_date" }).ok,
    "dateBefore: start after end rejected",
  );
  const endAfterStart = dateAfter({ startFieldId: "start_date" });
  assert(
    endAfterStart({ type: "date", value: "2026-12-31" }, { row, fieldId: "end_date" }).ok,
    "dateAfter: end after start ok",
  );
  assert(
    !endAfterStart({ type: "date", value: "2025-12-31" }, { row, fieldId: "end_date" }).ok,
    "dateAfter: end before start rejected",
  );

  // VALID / invalid sentinels
  assert(VALID.ok === true, "VALID sentinel ok");
  assert(invalid("nope").ok === false, "invalid sentinel ok=false");
}

describe("field validation engine", () => {
  it("validates field values and rule compiler fallbacks", () => {
    testFieldValidation();
  });
});
