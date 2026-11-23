// Field-value adapter engine.
//
// Pure functions that bridge between the substrate `FieldValue` envelope and
// the primitive shapes consumer surfaces use (string / boolean / etc.). Used
// by the `editable-grid` module's AG Grid `valueGetter` / `valueSetter`
// factories, but the functions themselves are React-agnostic so they're
// equally usable in tests, importers, CSV pipelines, or any non-grid surface
// that needs to round-trip FieldValue.
//
// Includes structural equality (`fieldValueEqual`) used to gate the no-op
// commit case: AG Grid (and any other host) will fire its commit callback on
// every editor close, even when the user typed nothing. Without this gate,
// every commit would create a buffer entry and dirty the cell.
//
// No React imports; no DOM. Tested as pure functions in
// `packages/engines/field-value-adapter/__tests__`.

import type { FieldValue, RecordKey } from "@contracts";

// Structural equality across all FieldValue variants. Returns true when
// `a` and `b` represent the same logical value, including the null/null case.
//
// Treat `null` and `""` (or other falsy primitives) as DIFFERENT — null means
// "no value", empty string means "explicit empty". Both are valid distinct
// states for a text field; conflating them would silently mask deletes.
export function fieldValueEqual(
  a: FieldValue | null | undefined,
  b: FieldValue | null | undefined,
): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  if (a.type !== b.type) return false;
  switch (a.type) {
    case "text":
    case "number":
    case "date":
    case "datetime":
      return a.value === (b as typeof a).value;
    case "bool":
      return a.value === (b as typeof a).value;
    case "enum":
      return a.value === (b as typeof a).value;
    case "relation": {
      const bRel = b as Extract<FieldValue, { type: "relation" }>;
      return recordKeyEqual(a.value, bRel.value);
    }
    case "relation_list":
      return recordKeyListEqual(a.value, (b as typeof a).value);
    case "money_rate": {
      const bMr = b as Extract<FieldValue, { type: "money_rate" }>;
      return (
        a.value.amount === bMr.value.amount &&
        a.value.currency === bMr.value.currency &&
        a.value.period === bMr.value.period
      );
    }
    case "text_list":
      return textListEqual(a.value, (b as typeof a).value);
    case "json":
      return jsonValueEqual(a.value, (b as typeof a).value);
    case "schema_lifecycle":
      return a.value === (b as typeof a).value;
  }
}

function recordKeyEqual(a: RecordKey, b: RecordKey): boolean {
  if (a.type !== b.type) return false;
  if (a.type !== "lookup_or_create" || b.type !== "lookup_or_create") {
    return a.value === b.value;
  }
  return a.value.label === b.value.label && fieldValueMapEqual(a.value.values, b.value.values);
}

function recordKeyListEqual(a: RecordKey[], b: RecordKey[]): boolean {
  return a.length === b.length && a.every((value, index) => recordKeyEqual(value, b[index]!));
}

function fieldValueMapEqual(
  a: Record<string, FieldValue> | undefined,
  b: Record<string, FieldValue> | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  return textListEqual(aKeys, bKeys) && aKeys.every((key) => fieldValueEqual(a[key], b[key]));
}

function textListEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

function jsonValueEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((value, index) => jsonValueEqual(value, b[index]));
  }

  if (typeof a === "object" && typeof b === "object") {
    if (!isPlainJsonObject(a) || !isPlainJsonObject(b)) return false;
    const aKeys = Object.keys(a).sort();
    const bKeys = Object.keys(b).sort();
    if (!textListEqual(aKeys, bKeys)) return false;
    return aKeys.every((key) => jsonValueEqual(a[key], b[key]));
  }

  return false;
}

function isPlainJsonObject(value: object): value is Record<string, unknown> {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// Wrap a host primitive (the value an AG Grid editor / form input emits) into
// the substrate `FieldValue` envelope. `prior` is needed for variants that
// can't be reconstructed from a single primitive (e.g. money_rate has
// amount + currency + period); the caller passes the prior FieldValue so
// the wrap can preserve fields the primitive doesn't carry.
//
// money_rate currently round-trips prior verbatim — host editors that drive
// money_rate need to construct the FieldValue directly, not via this
// function. Documented as a deliberate gap; will revisit when a leaf editor
// for money_rate emits a richer commit value.
export function makeFieldValue(
  type: FieldValue["type"],
  primitive: unknown,
  prior: FieldValue | null,
): FieldValue {
  switch (type) {
    case "text":
      return { type: "text", value: primitive == null ? "" : String(primitive) };
    case "number":
      return { type: "number", value: primitive == null ? "" : String(primitive) };
    case "bool":
      return { type: "bool", value: Boolean(primitive) };
    case "date":
      return { type: "date", value: primitive == null ? "" : String(primitive) };
    case "datetime":
      return { type: "datetime", value: primitive == null ? "" : String(primitive) };
    case "relation": {
      // Preserve the prior's RecordKey discriminator so editing a cell
      // whose relation column uses `external_key` keys doesn't silently
      // flip the wire payload to `record_id`. Default to `record_id` when
      // there is no prior to match (fresh / cleared cell). Hosts that
      // need to mint a different default — e.g. an importer wiring
      // external_key pre-seeded relations on a new column — should use
      // `fieldSetterFromValue` + a leaf editor that emits the full
      // FieldValue, the same escape hatch money_rate uses.
      const keyType: RecordKey["type"] =
        prior && prior.type === "relation" ? prior.value.type : "record_id";
      if (keyType === "lookup_or_create") {
        throw new Error(
          "makeFieldValue: lookup_or_create relations cannot be reconstructed from a host primitive. " +
            "Use ctx.fieldSetterFromValue + ctx.fieldValueGetter so the full RecordKey is preserved.",
        );
      }
      const recordKey: RecordKey = { type: keyType, value: String(primitive ?? "") };
      return { type: "relation", value: recordKey };
    }
    case "relation_list":
      throw new Error(
        "makeFieldValue: relation_list cannot be reconstructed from a host primitive. " +
          "Use ctx.fieldSetterFromValue + ctx.fieldValueGetter so the full RecordKey list is preserved.",
      );
    case "money_rate":
      // Hosts that emit a primitive can't reconstruct a money_rate envelope
      // (amount + currency + period). Loud failure beats silent no-op:
      // forgetting to use `fieldSetterFromValue` for a money_rate column
      // would otherwise drop every commit silently. Editors that emit a
      // full FieldValue (e.g. MoneyRateEditor via `ctx.fieldSetterFromValue`)
      // bypass this function entirely.
      throw new Error(
        "makeFieldValue: money_rate cannot be reconstructed from a host primitive. " +
          "Use ctx.fieldSetterFromValue + ctx.fieldValueGetter for money_rate columns " +
          "so the editor's full FieldValue commit reaches the buffer.",
      );
    case "enum":
      return { type: "enum", value: String(primitive ?? "") };
    case "text_list":
      return {
        type: "text_list",
        value: Array.isArray(primitive) ? primitive.map(String) : [],
      };
    case "json":
      return { type: "json", value: primitive };
    case "schema_lifecycle":
      if (primitive !== "active" && primitive !== "retired") {
        throw new Error(
          `makeFieldValue: schema_lifecycle must be "active" or "retired", got ${String(primitive)}`,
        );
      }
      return { type: "schema_lifecycle", value: primitive };
  }
}

// Unwrap a FieldValue into a host primitive. Relation returns the inner
// `value` string (record_id or external_key — opaque to the host).
// money_rate is rendered as a display string because hosts need a single
// scalar for cell display; richer rendering is the host's responsibility
// via valueFormatter / cellRenderer.
export function fieldValuePrimitive(fv: FieldValue | null | undefined): unknown {
  if (fv == null) return null;
  switch (fv.type) {
    case "relation":
      return fv.value.type === "lookup_or_create" ? fv.value.value.label : fv.value.value;
    case "relation_list":
      return fv.value.map((key) => (key.type === "lookup_or_create" ? key.value.label : key.value));
    case "money_rate":
      return `${fv.value.amount} ${fv.value.currency} / ${fv.value.period}`;
    case "text_list":
      return fv.value.join(", ");
    case "json":
      return JSON.stringify(fv.value);
    default:
      return (fv as { value: unknown }).value;
  }
}

// Stable string identity for a RecordKey: `<type>:<value>`. Relation label
// and option lookups key by this, so a `record_id` and an `external_key`
// with the same text never collide.
export function serializeRecordKey(key: RecordKey | null | undefined): string {
  if (key == null) return "";
  const value = key.type === "lookup_or_create" ? JSON.stringify(key.value) : key.value;
  return `${key.type}:${value}`;
}
