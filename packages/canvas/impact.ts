import type { WorkChange, WorkTarget } from "@autograph/generated-app-runtime/data";
import type { LabelIndex } from "@autograph/work-session-tools/labels";

type FieldValue = NonNullable<WorkChange["value"]>;

/** A money total's currency and period; plain numbers have none. */
export type ImpactUnit = { currency: string; period: string };

/**
 * One staged column's impact, from the staged entries alone (no reads):
 * - `totals` (number and money columns): the sum of the published values the
 *   changes started from beside the sum of the staged values, over the changed
 *   records only, per currency and period; an empty value adds nothing. A
 *   money change from one currency or period to another is not summed: it is
 *   counted in `unitMoves` (how many records move between them).
 * - `moves` (enum, relation and yes/no columns): how many records move from
 *   one value to another.
 * - `changes` (every other column): how many changes it has.
 */
export type FieldImpact = {
  model_id: string;
  field_id: string;
  /** How many staged changes the column has. */
  count: number;
} & (
  | {
      kind: "totals";
      totals: { unit: ImpactUnit | null; before: string; after: string; records: number }[];
      unitMoves: { from: ImpactUnit; to: ImpactUnit; count: number }[];
    }
  | {
      kind: "moves";
      moves: { from: FieldValue | null; to: FieldValue | null; count: number }[];
    }
  | { kind: "changes" }
);

/** A staged entry Save writes: one whose record or column is gone is dropped at Save. */
const written = <T extends { gone?: WorkChange["gone"] }>(entries: readonly T[]) =>
  entries.filter((entry) => entry.gone == null);

/**
 * Records affected: distinct (model, record) pairs across the staged entries
 * Save writes (gone entries are dropped at Save, so they are not counted).
 */
export function recordsAffected(
  entries: readonly (WorkTarget & { gone?: WorkChange["gone"] })[],
): number {
  return new Set(written(entries).map((entry) => JSON.stringify([entry.model_id, entry.record_id])))
    .size;
}

/** A decimal string as a scaled integer, or null when it is not one. */
function scaled(value: string, scale: number): bigint | null {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/u.exec(value.trim());
  if (match === null) return null;
  const [, sign, whole, fraction = ""] = match;
  if (fraction.length > scale) return null;
  const digits = BigInt(whole! + fraction.padEnd(scale, "0"));
  return sign === "-" ? -digits : digits;
}

/** The exact sum of decimal strings, never through a float; non-decimals are skipped. */
export function sumDecimals(values: readonly string[]): string {
  const scale = Math.max(0, ...values.map((value) => value.split(".")[1]?.length ?? 0));
  let total = 0n;
  for (const value of values) total += scaled(value, scale) ?? 0n;
  const negative = total < 0n;
  const digits = (negative ? -total : total).toString().padStart(scale + 1, "0");
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale).replace(/0+$/u, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

/** A number or money value's amount and unit; null for an empty or other value. */
function amountOf(value: FieldValue | null): { amount: string; unit: ImpactUnit | null } | null {
  if (value?.type === "number") return { amount: String(value.value), unit: null };
  if (value?.type === "money_rate")
    return {
      amount: value.value.amount,
      unit: { currency: value.value.currency, period: value.value.period },
    };
  return null;
}

const totalTypes = new Set(["number", "money_rate"]);
const choiceTypes = new Set(["enum", "relation", "bool"]);

/**
 * The staged entries' impact per column, in the order the columns first
 * appear: computed client-side from each entry's staged value and the
 * published value it started from, so showing it reads nothing. Gone entries
 * (dropped at Save) count for nothing.
 */
export function stagedImpact(
  labels: LabelIndex,
  entries: readonly (Pick<
    WorkChange,
    "model_id" | "record_id" | "field_id" | "value" | "baseline"
  > &
    Partial<Pick<WorkChange, "gone">>)[],
): FieldImpact[] {
  const byField = new Map<string, (typeof entries)[number][]>();
  for (const entry of written(entries)) {
    const key = JSON.stringify([entry.model_id, entry.field_id]);
    byField.set(key, [...(byField.get(key) ?? []), entry]);
  }
  return [...byField.values()].map((items) => {
    const { model_id, field_id } = items[0]!;
    const field = labels.fieldById(labels.modelById(model_id), field_id);
    const base = { model_id, field_id, count: items.length };
    if (field !== undefined && totalTypes.has(field.type)) {
      const totals = new Map<
        string,
        { unit: ImpactUnit | null; before: string[]; after: string[]; records: Set<string> }
      >();
      const add = (value: FieldValue | null, side: "before" | "after", recordId: string) => {
        const amount = amountOf(value);
        if (amount === null) return;
        const id = amount.unit === null ? "" : `${amount.unit.currency}/${amount.unit.period}`;
        const total = totals.get(id) ?? {
          unit: amount.unit,
          before: [],
          after: [],
          records: new Set(),
        };
        total[side].push(amount.amount);
        total.records.add(recordId);
        totals.set(id, total);
      };
      const unitKey = (unit: ImpactUnit) => `${unit.currency}/${unit.period}`;
      const unitMoves = new Map<string, { from: ImpactUnit; to: ImpactUnit; count: number }>();
      for (const entry of items) {
        const from = amountOf(entry.baseline)?.unit ?? null;
        const to = amountOf(entry.value)?.unit ?? null;
        if (from !== null && to !== null && unitKey(from) !== unitKey(to)) {
          // Another currency or period: a move, never a drop in one total and a rise in another.
          const key = JSON.stringify([unitKey(from), unitKey(to)]);
          const move = unitMoves.get(key) ?? { from, to, count: 0 };
          move.count += 1;
          unitMoves.set(key, move);
          continue;
        }
        add(entry.baseline, "before", entry.record_id);
        add(entry.value, "after", entry.record_id);
      }
      return {
        ...base,
        kind: "totals" as const,
        totals: [...totals.entries()]
          .toSorted(([a], [b]) => a.localeCompare(b))
          .map(([, total]) => ({
            unit: total.unit,
            before: sumDecimals(total.before),
            after: sumDecimals(total.after),
            records: total.records.size,
          })),
        unitMoves: [...unitMoves.values()].toSorted((a, b) => b.count - a.count),
      };
    }
    if (field !== undefined && choiceTypes.has(field.type)) {
      const moves = new Map<
        string,
        { from: FieldValue | null; to: FieldValue | null; count: number }
      >();
      for (const entry of items) {
        const key = JSON.stringify([entry.baseline, entry.value]);
        const move = moves.get(key) ?? { from: entry.baseline, to: entry.value, count: 0 };
        move.count += 1;
        moves.set(key, move);
      }
      return {
        ...base,
        kind: "moves" as const,
        // Most-moved first; ties keep the order they were staged in.
        moves: [...moves.values()].toSorted((a, b) => b.count - a.count),
      };
    }
    return { ...base, kind: "changes" as const };
  });
}
