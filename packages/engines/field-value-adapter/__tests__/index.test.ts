import { fieldValueEqual, fieldValuePrimitive, makeFieldValue } from "../index";
import type { FieldValue } from "../../../contracts/index";

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

function testFieldValueAdapter() {
  // Equality: null vs undefined collapse, but null vs "" stay distinct.
  assert(fieldValueEqual(null, null), "equal: null/null");
  assert(fieldValueEqual(undefined, undefined), "equal: undefined/undefined");
  assert(fieldValueEqual(null, undefined), "equal: null/undefined collapse");
  assert(
    !fieldValueEqual({ type: "text", value: "" }, { type: "text", value: "x" }),
    "equal: text empty vs nonempty distinct",
  );
  assert(
    !fieldValueEqual(null, { type: "text", value: "" }),
    "equal: null and explicit empty text are DIFFERENT (delete vs blank)",
  );

  // Type mismatch never equal.
  assert(
    !fieldValueEqual({ type: "text", value: "1" }, { type: "number", value: "1" }),
    "equal: cross-type rejection",
  );

  // Variant-by-variant: equal-self ⇒ true; equal-different ⇒ false.
  const variants: FieldValue[] = [
    { type: "text", value: "abc" },
    { type: "number", value: "42" },
    { type: "bool", value: true },
    { type: "date", value: "2026-05-13" },
    { type: "datetime", value: "2026-05-13T00:00:00Z" },
    { type: "relation", value: { type: "record_id", value: "uuid-1" } },
    {
      type: "relation",
      value: { type: "lookup_or_create", value: { label: "Finance" } },
    },
    {
      type: "relation_list",
      value: [
        { type: "record_id", value: "uuid-1" },
        { type: "lookup_or_create", value: { label: "Finance" } },
      ],
    },
    { type: "text_list", value: ["a", "b"] },
    { type: "json", value: { x: 1 } },
    { type: "enum", value: "active" },
    {
      type: "money_rate",
      value: { amount: "1000.00", currency: "USD", period: "annual" },
    },
    { type: "schema_lifecycle", value: "active" },
  ];
  for (const v of variants) {
    assert(fieldValueEqual(v, v), `equal: ${v.type} self-equality`);
    assert(fieldValueEqual(v, structuredClone(v)), `equal: ${v.type} structural-clone equality`);
  }

  assert(
    fieldValueEqual(
      { type: "json", value: { a: 1, b: { c: true, d: [1, 2] } } },
      { type: "json", value: { b: { d: [1, 2], c: true }, a: 1 } },
    ),
    "equal: json object key order is ignored recursively",
  );
  assert(
    !fieldValueEqual({ type: "json", value: [1, 2] }, { type: "json", value: [2, 1] }),
    "equal: json array order remains significant",
  );
  assert(
    !fieldValueEqual(
      { type: "text_list", value: ["a", "b"] },
      { type: "text_list", value: ["b", "a"] },
    ),
    "equal: text_list order remains significant",
  );
  assert(
    !fieldValueEqual({ type: "enum", value: "active" }, { type: "enum", value: "inactive" }),
    "equal: enum distinct option ids",
  );

  // Relation: distinct record_ids are not equal.
  assert(
    !fieldValueEqual(
      { type: "relation", value: { type: "record_id", value: "uuid-1" } },
      { type: "relation", value: { type: "record_id", value: "uuid-2" } },
    ),
    "equal: relation distinct record_id",
  );
  assert(
    !fieldValueEqual(
      {
        type: "relation",
        value: {
          type: "lookup_or_create",
          value: { label: "Finance", values: { code: { type: "text", value: "FIN" } } },
        },
      },
      {
        type: "relation",
        value: {
          type: "lookup_or_create",
          value: { label: "Finance", values: { code: { type: "text", value: "OPS" } } },
        },
      },
    ),
    "equal: lookup_or_create compares nested values",
  );

  // money_rate: distinct on any of amount/currency/period.
  const baseMr: FieldValue = {
    type: "money_rate",
    value: { amount: "1000.00", currency: "USD", period: "annual" },
  };
  assert(
    !fieldValueEqual(baseMr, {
      type: "money_rate",
      value: { amount: "1001.00", currency: "USD", period: "annual" },
    }),
    "equal: money_rate amount distinct",
  );
  assert(
    !fieldValueEqual(baseMr, {
      type: "money_rate",
      value: { amount: "1000.00", currency: "EUR", period: "annual" },
    }),
    "equal: money_rate currency distinct",
  );
  assert(
    !fieldValueEqual(baseMr, {
      type: "money_rate",
      value: { amount: "1000.00", currency: "USD", period: "monthly" },
    }),
    "equal: money_rate period distinct",
  );

  // makeFieldValue/fieldValuePrimitive round-trips.
  for (const v of variants) {
    if (v.type === "money_rate") continue; // wrap doesn't reconstruct from a primitive
    if (v.type === "text_list") continue;
    if (v.type === "json") continue;
    if (v.type === "relation") continue;
    if (v.type === "relation_list") continue;
    const primitive = fieldValuePrimitive(v);
    const wrapped = makeFieldValue(v.type, primitive, null);
    assert(fieldValueEqual(v, wrapped), `round-trip: ${v.type} primitive ↔ FieldValue`);
  }

  // Relation primitive is record_id string; wrap reconstructs as record_id key.
  const rel = variants.find((v) => v.type === "relation")!;
  const relP = fieldValuePrimitive(rel);
  assertEqual(relP, "uuid-1", "primitive: relation returns inner value");
  const relWrapped = makeFieldValue("relation", relP, null);
  assert(fieldValueEqual(rel, relWrapped), "round-trip: relation record_id key");

  // makeFieldValue("relation", primitive, prior) preserves prior's RecordKey
  // discriminator. Default is `record_id` (when no prior exists or prior is
  // not a relation); when prior IS a relation with `external_key`, the
  // reconstructed value preserves that — otherwise editing a cell whose
  // column uses external_key would silently flip the wire payload to
  // record_id.
  const externalKeyRel: FieldValue = {
    type: "relation",
    value: { type: "external_key", value: "dept-finance" },
  };
  const externalKeyWrapped = makeFieldValue("relation", "dept-marketing", externalKeyRel);
  assert(
    externalKeyWrapped.type === "relation" &&
      externalKeyWrapped.value.type === "external_key" &&
      externalKeyWrapped.value.value === "dept-marketing",
    "wrap: relation preserves prior's external_key discriminator across edits",
  );

  // No-prior case defaults to record_id (the spike's HC default).
  const freshRelWrap = makeFieldValue("relation", "uuid-fresh", null);
  assert(
    freshRelWrap.type === "relation" &&
      freshRelWrap.value.type === "record_id" &&
      freshRelWrap.value.value === "uuid-fresh",
    "wrap: relation with null prior defaults to record_id",
  );

  // makeFieldValue(text, null, prior) yields explicit "" — null primitive
  // means "user cleared the input", not "no value at all".
  const cleared = makeFieldValue("text", null, { type: "text", value: "x" });
  assert(
    cleared.type === "text" && cleared.value === "",
    "wrap: null text primitive becomes explicit empty",
  );

  // makeFieldValue(money_rate, ...) THROWS — money_rate envelopes can't be
  // reconstructed from a host primitive. Editors that emit a full FieldValue
  // (e.g. MoneyRateEditor via `ctx.fieldSetterFromValue`) bypass makeFieldValue
  // entirely. Loud failure beats silent no-op when a column accidentally
  // wires the primitive path for money_rate.
  const mrPrior: FieldValue = {
    type: "money_rate",
    value: { amount: "500", currency: "USD", period: "monthly" },
  };
  assertThrows(
    () => makeFieldValue("money_rate", "ignored", mrPrior),
    "money_rate cannot be reconstructed from a host primitive",
    "wrap: money_rate primitive path throws (must use fieldSetterFromValue)",
  );
  assertEqual(
    fieldValuePrimitive({ type: "enum", value: "active" }),
    "active",
    "primitive: enum returns option id",
  );
  assertEqual(
    fieldValuePrimitive({
      type: "relation",
      value: { type: "lookup_or_create", value: { label: "Finance" } },
    }),
    "Finance",
    "primitive: lookup_or_create relation returns its label",
  );
  nodeAssert.deepEqual(
    fieldValuePrimitive({
      type: "relation_list",
      value: [
        { type: "record_id", value: "uuid-1" },
        { type: "lookup_or_create", value: { label: "Finance" } },
      ],
    }),
    ["uuid-1", "Finance"],
    "primitive: relation_list returns key display values",
  );
  assertThrows(
    () =>
      makeFieldValue("relation", "Finance", {
        type: "relation",
        value: { type: "lookup_or_create", value: { label: "Finance" } },
      }),
    "lookup_or_create relations cannot be reconstructed",
    "wrap: lookup_or_create relation primitive path throws",
  );
  assertThrows(
    () => makeFieldValue("relation_list", [], null),
    "relation_list cannot be reconstructed",
    "wrap: relation_list primitive path throws",
  );
  assert(
    fieldValueEqual(makeFieldValue("schema_lifecycle", "retired", null), {
      type: "schema_lifecycle",
      value: "retired",
    }),
    "wrap: schema_lifecycle accepts a valid state",
  );
  assertThrows(
    () => makeFieldValue("schema_lifecycle", "deleted", null),
    'schema_lifecycle must be "active" or "retired"',
    "wrap: schema_lifecycle rejects an invalid state",
  );
  assert(
    fieldValueEqual(makeFieldValue("enum", "active", { type: "enum", value: "inactive" }), {
      type: "enum",
      value: "active",
    }),
    "wrap: enum primitive path emits the selected option id",
  );
}

describe("field value adapter engine", () => {
  it("adapts and compares field values", () => {
    testFieldValueAdapter();
  });
});
