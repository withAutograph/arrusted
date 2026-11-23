import { useEffect, useMemo, useState } from "react";
import type { DataField, WorkChange } from "@autograph/generated-app-runtime/data";
import {
  createLabelIndex,
  displayWire,
  type LabelIndex,
} from "@autograph/work-session-tools/labels";
import type { CanvasClient } from "./client";
import { formatMoney } from "./money";
import { relationKey, relationKeyFilter, titleField, type RelationKey } from "./record-values";

type FieldValue = NonNullable<WorkChange["value"]>;
/** A record by model and key: an entry's own record id, or a relation's key as stored. */
type RecordRef = { model_id: string; key: RelationKey };
const refKey = (ref: RecordRef) => JSON.stringify([ref.model_id, ref.key.type, ref.key.value]);

/** The relation keys a relation or relation-list value holds. */
const relationKeys = (value: FieldValue | null | undefined): RelationKey[] =>
  value?.type === "relation" || value?.type === "relation_list"
    ? (Array.isArray(value.value) ? value.value : [value.value]).flatMap((item) => {
        const key = relationKey(item);
        return key === null ? [] : [key];
      })
    : [];

/** Every record an entry names: its own and any related records in its values. */
function referencedRecords(labels: LabelIndex, entries: readonly WorkChange[]): RecordRef[] {
  const refs: RecordRef[] = [];
  for (const entry of entries) {
    refs.push({ model_id: entry.model_id, key: { type: "record_id", value: entry.record_id } });
    const field = labels.fieldById(labels.modelById(entry.model_id), entry.field_id);
    const target = typeof field?.target_model === "string" ? field.target_model : undefined;
    if (target === undefined) continue;
    for (const value of [entry.value, entry.baseline, entry.current_value])
      for (const key of relationKeys(value)) refs.push({ model_id: target, key });
  }
  return refs;
}

/**
 * Record names for the staged entries, read over the session through the
 * host's data client. A record the read does not return (gone, or not
 * readable) has no name; callers say what it is instead of showing its id.
 */
export function useRecordNames(
  client: CanvasClient,
  input: {
    sessionId: string;
    asOf: string | null;
    /** `CanvasSession.generation`: every read, even at the same revision, may rename records. */
    generation: number;
    entries: readonly WorkChange[];
  },
) {
  const labels = useMemo(() => createLabelIndex(client.definition), [client.definition]);
  const [read, setRead] = useState<{
    generation: number | null;
    names: ReadonlyMap<string, string | null>;
  }>({ generation: null, names: new Map() });
  const wanted = useMemo(
    () => [
      ...new Map(
        referencedRecords(labels, input.entries).map((ref) => [refKey(ref), ref]),
      ).values(),
    ],
    [labels, input.entries],
  );
  const { asOf, sessionId, generation } = input;

  useEffect(() => {
    if (asOf === null) return;
    // A new read may rename records: read them all again, keeping the old names meanwhile.
    const missing =
      generation === read.generation
        ? wanted.filter((ref) => !read.names.has(refKey(ref)))
        : wanted;
    if (missing.length === 0) return;
    let live = true;
    void Promise.all(
      missing.map(async (ref): Promise<[string, string | null]> => {
        const field = titleField(labels.modelById(ref.model_id));
        if (field === undefined) return [refKey(ref), null];
        try {
          const [record] = await client.data.list(ref.model_id, {
            asOf,
            work: { sessionId },
            where: [relationKeyFilter(ref.key)],
            limit: 1,
          });
          const value = record?.[field.name];
          return [refKey(ref), typeof value === "string" && value.trim() !== "" ? value : null];
        } catch {
          return [refKey(ref), null];
        }
      }),
    ).then((found) => {
      if (!live) return;
      setRead((current) => {
        const names = new Map(current.names);
        // A record that stops reading (removed) keeps the name it was shown with.
        for (const [key, name] of found) names.set(key, name ?? current.names.get(key) ?? null);
        return { generation, names };
      });
    });
    return () => {
      live = false;
    };
  }, [client, asOf, sessionId, generation, wanted, read, labels]);

  return useMemo(() => {
    /** A record's name, or what it is ("Removed Project", "Project") when it has none. */
    const recordName = (ref: {
      model_id: string;
      record_id: string;
      gone?: WorkChange["gone"];
    }) => {
      const name = read.names.get(
        refKey({ model_id: ref.model_id, key: { type: "record_id", value: ref.record_id } }),
      );
      if (typeof name === "string") return name;
      const model = labels.modelLabel(ref.model_id);
      return ref.gone === "record_gone" ? `Removed ${model}` : model;
    };
    /** A related record's name by its key; an unnamed external key shows as the key. */
    const relatedName = (modelId: string, key: RelationKey) => {
      const name = read.names.get(refKey({ model_id: modelId, key }));
      if (typeof name === "string") return name;
      return key.type === "external_key" ? key.value : labels.modelLabel(modelId);
    };
    return { labels, recordName, relatedName };
  }, [labels, read]);
}
export type RecordNames = ReturnType<typeof useRecordNames>;

/** Decimal strings with thousands separators, never through a float. */
export function groupDigits(amount: string): string {
  const match = /^(-?)(\d+)(\.\d+)?$/u.exec(amount);
  if (!match) return amount;
  const [, sign, whole, fraction = ""] = match;
  return `${sign}${whole!.replace(/\B(?=(\d{3})+(?!\d))/gu, ",")}${fraction}`;
}

export { formatMoney };

/** The exact difference of two decimal strings. */
export function subtractDecimals(left: string, right: string): string {
  const scale = Math.max(...[left, right].map((v) => v.split(".")[1]?.length ?? 0));
  const scaled = (v: string) => {
    const [whole, fraction = ""] = v.replace("-", "").split(".");
    return BigInt(whole + fraction.padEnd(scale, "0")) * (v.startsWith("-") ? -1n : 1n);
  };
  const total = scaled(left) - scaled(right);
  const digits = (total < 0n ? -total : total).toString().padStart(scale + 1, "0");
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale).replace(/0+$/, "");
  return `${total < 0n ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

/**
 * A staged, baseline or current value as the log shows it: option labels,
 * related records by name, money with currency and period. `null` is empty.
 */
export function formatValue(
  names: RecordNames,
  field: DataField | undefined,
  value: FieldValue | null | undefined,
): string | null {
  if (value === null || value === undefined) return null;
  const target = typeof field?.target_model === "string" ? field.target_model : undefined;
  // Relations by the related record's name, matched by key type and value.
  if (target !== undefined && (value.type === "relation" || value.type === "relation_list"))
    return relationKeys(value)
      .map((key) => names.relatedName(target, key))
      .join(", ");
  const shown = displayWire(names.labels, field, value);
  if (shown === null || shown === undefined) return null;
  const one = (item: unknown): string => (typeof item === "string" ? item : JSON.stringify(item));
  switch (value.type) {
    case "money_rate":
      return formatMoney(value.value.amount, value.value);
    case "number":
      // Exact: a change past the fourth decimal must still show as a change.
      return groupDigits(String(value.value));
    case "bool":
      return value.value ? "Yes" : "No";
    default:
      return Array.isArray(shown) ? shown.map(one).join(", ") : one(shown);
  }
}

/** A column's header, or "a removed column" when the definition no longer has it; never its id. */
export function columnHeader(labels: LabelIndex, modelId: string, fieldId: string): string {
  return labels.fieldById(labels.modelById(modelId), fieldId) === undefined
    ? "a removed column"
    : labels.header(modelId, fieldId);
}

/** An entry's record name and column header. */
export function entryLabel(names: RecordNames, entry: WorkChange) {
  return {
    record: names.recordName(entry),
    header: columnHeader(names.labels, entry.model_id, entry.field_id),
  };
}

const timeFormat = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
/** A staging time as people read it. */
export const formatTime = (iso: string) => timeFormat.format(new Date(iso));
