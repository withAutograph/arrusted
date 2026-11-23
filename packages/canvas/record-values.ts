import type { DataDefinition, DataField, DataModel } from "@autograph/generated-app-runtime/data";
import {
  encodeCell,
  fieldHeader,
  modelLabel,
  titleFieldOf,
  type LabelIndex,
} from "@autograph/work-session-tools/labels";
import type { Field, FieldType, FieldValue, RecordKey, Schema, VisibleRecord } from "@contracts";
import { formatField } from "@engines/format/index";

import type { CanvasRecord } from "./client";
import { formatMoney, formatNumber } from "./money";

/** Column types the shared grid and record panel show; others (relation lists) stay hidden. */
const shown = new Set<string>([
  "text",
  "number",
  "bool",
  "date",
  "datetime",
  "relation",
  "text_list",
  "known_aliases",
  "json",
  "enum",
  "iso_country",
  "iso_currency",
  "money_rate",
]);

/** The model's columns the canvas shows, in definition order. */
export const shownFields = (model: DataModel): DataField[] =>
  model.fields.filter(
    (field) => shown.has(field.type) && field.lifecycle !== "retired" && !field.aliasOf,
  );

/**
 * The column that names a model's records: the model's `display_field_id`
 * when the definition sets one, else its first text column that is not
 * retired, preferring one that is not a unique key (a key is an identifier,
 * not a name).
 */
export function titleField(model: DataModel | undefined): DataField | undefined {
  return titleFieldOf(model);
}

/** Natural order of names: "L3" before "L4" before "L10". */
export const naturalOrder = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

/**
 * Records in natural order of their name column, then id. The kernel orders
 * names as text ("L10" before "L4"); only a complete set may be re-ordered
 * here, since a page cut in text order would leave records out of place.
 */
export function naturalRecordOrder(model: DataModel, records: readonly CanvasRecord[]) {
  const field = titleField(model);
  if (field === undefined) return [...records];
  const name = (record: CanvasRecord) => {
    const value = record[field.name];
    return typeof value === "string" || typeof value === "number" ? String(value) : null;
  };
  const byId = (a: CanvasRecord, b: CanvasRecord) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  // Unnamed records last, as the kernel orders nulls in an ascending sort.
  return records.toSorted((a, b) => {
    const [x, y] = [name(a), name(b)];
    if (x === null || y === null) return Number(x === null) - Number(y === null) || byId(a, b);
    return naturalOrder.compare(x, y) || byId(a, b);
  });
}

/** A relation's key: a record id or an external key, kept apart end to end. */
export type RelationKey = { type: "record_id" | "external_key"; value: string };

/** The relation key a value holds (`{ type, value }`), else null. */
export function relationKey(value: unknown): RelationKey | null {
  if (value === null || typeof value !== "object") return null;
  const { type, value: inner } = value as { type?: unknown; value?: unknown };
  return (type === "record_id" || type === "external_key") && typeof inner === "string"
    ? { type, value: inner }
    : null;
}

/** A relation key as a map key: its type and value. */
export const relationKeyId = (key: RelationKey) => `${key.type}:${key.value}`;

/** The list filter that reads the record a relation key names, by id or external key. */
export const relationKeyFilter = (key: RelationKey) => ({
  field: key.type === "record_id" ? "id" : "externalKey",
  op: "eq" as const,
  value: key.value,
});

/** A record's name as people read it: its title column, else "Untitled <model>". */
export function recordTitle(model: DataModel, record: CanvasRecord | undefined): string {
  const field = titleField(model);
  const value = field === undefined ? undefined : record?.[field.name];
  if (typeof value === "number") return String(value);
  return typeof value === "string" && value.trim() !== "" ? value : `Untitled ${modelLabel(model)}`;
}

/**
 * The app's data definition as the shared grid's schema: the same model and
 * field ids, labelled by column header. The grid builds its columns and
 * editors from it; nothing here validates.
 */
export function gridSchema(
  definition: DataDefinition,
  fields: (model: DataModel) => readonly DataField[] = shownFields,
): Schema {
  return {
    app_id: "canvas",
    customer_id: "canvas",
    version: definition.schemaVersion,
    change_types: [],
    models: definition.models.map((model) => ({
      id: model.id,
      kind: "entity",
      label: modelLabel(model),
      fields: fields(model)
        .filter((field) => !field.aliasOf)
        .map((field): Field => ({
          id: field.id,
          label: fieldHeader(field),
          type: field.type as FieldType,
          required: field.required,
          ...(typeof field.target_model === "string" ? { target_model: field.target_model } : {}),
          ...(Array.isArray(field.option_set)
            ? {
                option_set: field.option_set.map((option) => ({
                  id: option.id,
                  label: typeof option.label === "string" ? option.label : option.id,
                })),
              }
            : {}),
        })),
    })),
  };
}

/** A record the data client decoded (values by field name) as wire values by field id. */
export function fieldValues(
  labels: LabelIndex,
  model: DataModel,
  record: CanvasRecord,
): Record<string, FieldValue> {
  const values: Record<string, FieldValue> = {};
  for (const field of shownFields(model)) {
    const raw = record[field.name];
    if (raw === null || raw === undefined) continue;
    const value = encodeCell(labels, field, raw);
    if (value !== null) values[field.id] = value;
  }
  return values;
}

/**
 * What of a record shows from pending drafts (Show drafts on): the draft
 * that creates it, and by field id the draft whose value shows. Null when
 * nothing does, and always with Show drafts off (the read says nothing).
 */
export type DraftOrigin = { created: number | null; fields: ReadonlyMap<string, number> };

export function draftOrigin(
  model: DataModel,
  record: CanvasRecord | null | undefined,
): DraftOrigin | null {
  const pending = record?.pendingDraft as
    | { created?: number; fields?: Record<string, number> }
    | undefined;
  if (pending === undefined || pending === null) return null;
  const fields = new Map<string, number>();
  for (const field of model.fields) {
    const draft = pending.fields?.[field.name];
    if (typeof draft === "number") fields.set(field.id, draft);
  }
  const created = typeof pending.created === "number" ? pending.created : null;
  return created === null && fields.size === 0 ? null : { created, fields };
}

/**
 * The column a draft-created record's mark sits on: its name column, or, for
 * a model without one, its first shown column that is not a key (the grid
 * starts key columns hidden), else its first shown column.
 */
export function creationMarkField(model: DataModel | undefined): string | undefined {
  if (model === undefined) return undefined;
  const fields = shownFields(model);
  return (
    titleField(model)?.id ?? (fields.find((field) => field.is_unique !== true) ?? fields[0])?.id
  );
}

/**
 * The quiet draft mark of one value: on a draft-created record's name, that
 * it is new (and edited in Review, not here); on a value a pending draft
 * changed, which draft. A created record's own values are not marked again.
 */
export function draftMark(
  origin: DraftOrigin | null,
  fieldId: string,
  /** Where a creation is marked (`creationMarkField`). */
  markFieldId: string | undefined,
): { label: string; title: string } | undefined {
  if (origin === null) return undefined;
  if (origin.created !== null && fieldId === markFieldId)
    return { label: "draft", title: `New in draft #${origin.created}. Edit it in Review.` };
  const draft = origin.fields.get(fieldId);
  if (draft === undefined || draft === origin.created) return undefined;
  return { label: "draft", title: `In draft #${draft}` };
}

/** A record as one grid row. */
export function toVisibleRecord(
  labels: LabelIndex,
  model: DataModel,
  record: CanvasRecord,
  asOf: string,
): VisibleRecord {
  return {
    record_id: record.id,
    effective_start: asOf,
    values: fieldValues(labels, model, record),
    custom_fields: [],
  };
}

/**
 * A value as the grid shows it: money as people read it (`$150,000`,
 * `$42.50/hr`), derived (read-only) numbers grouped with at most four
 * decimals, links by the linked record's name, enums by label.
 */
export function formatValue(
  field: Field & { readOnly?: boolean },
  value: FieldValue | null | undefined,
  linkName: (key: RecordKey) => string | undefined,
): string {
  if (value == null) return "";
  if (value.type === "money_rate") return formatMoney(value.value.amount, value.value);
  // An editable number keeps every digit, so an edit reads as one.
  if (value.type === "number" && field.readOnly) return formatNumber(String(value.value));
  return formatField(value, field, { relationLabel: (key) => linkName(key) ?? "Unknown record" });
}

/**
 * The currency and period an empty money value of a record takes: those of
 * `source`, the money field the app names for the model (e.g. a target
 * amount), when the record has it; else the record's first money value;
 * else the money editor's own first choice (US dollars, annual). The grid
 * passes these to the money editor as its defaults and shows them beside an
 * empty value, in the grid and the record panel, so a default is never silent.
 */
export function moneyDefaults(
  model: DataModel,
  record: CanvasRecord | undefined,
  source?: string,
): { currency: string; period: string } {
  const unit = (field: DataModel["fields"][number]) => {
    if (field.type !== "money_rate" || field.lifecycle === "retired") return null;
    const value = record?.[field.name] as
      | { currency?: unknown; period?: unknown }
      | null
      | undefined;
    return typeof value?.currency === "string" && typeof value.period === "string"
      ? { currency: value.currency, period: value.period }
      : null;
  };
  const named = model.fields.find((field) => field.id === source);
  const fromSource = named === undefined ? null : unit(named);
  if (fromSource !== null) return fromSource;
  for (const field of model.fields) {
    const found = unit(field);
    if (found !== null) return found;
  }
  return { currency: "USD", period: "annual" };
}

/** An empty money value's default, as its note reads: "Takes USD · annual". */
export const moneyDefaultNote = (defaults: { currency: string; period: string }) =>
  `Takes ${defaults.currency} · ${defaults.period}`;
