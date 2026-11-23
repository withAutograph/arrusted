import { Fragment, useMemo } from "react";
import type { DataField } from "@autograph/generated-app-runtime/data";
import type { CanvasClient } from "./client";
import { recordsAffected, stagedImpact, type FieldImpact, type ImpactUnit } from "./impact";
import { formatMoney } from "./money";
import {
  columnHeader,
  formatValue,
  groupDigits,
  subtractDecimals,
  useRecordNames,
  type RecordNames,
} from "./review-labels";
import type { CanvasSession } from "./use-canvas-session";

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

/** An amount as people read it: money with its currency and period, numbers grouped. */
const formatAmount = (amount: string, unit: ImpactUnit | null) =>
  unit === null ? groupDigits(amount) : formatMoney(amount, unit);

/** A total's difference, signed (`+$20,000`); "0" when it shows as nothing. */
export function impactDifference(total: {
  before: string;
  after: string;
  unit: ImpactUnit | null;
}): string {
  const difference = subtractDecimals(total.after, total.before);
  const negative = difference.startsWith("-");
  const shown = formatAmount(negative ? difference.slice(1) : difference, total.unit);
  // A difference that shows as nothing (under a dollar of an annual sum) is none.
  if (shown === formatAmount("0", total.unit)) return "0";
  return `${negative ? "−" : "+"}${shown}`;
}

/** One column's impact as a line of text after its header. */
export function impactLine(
  names: RecordNames,
  field: DataField | undefined,
  impact: FieldImpact,
): string[] {
  switch (impact.kind) {
    case "totals":
      return [
        ...impact.totals.map((total) => {
          const difference = impactDifference(total);
          const over = `over ${plural(total.records, "changed record")}`;
          return difference === "0"
            ? `${formatAmount(total.after, total.unit)} ${over}, no change`
            : `${formatAmount(total.before, total.unit)} → ${formatAmount(total.after, total.unit)} (${difference}) ${over}`;
        }),
        ...impact.unitMoves.map(
          (move) =>
            `${plural(move.count, "record")} ${move.from.currency} ${move.from.period} → ${move.to.currency} ${move.to.period}`,
        ),
      ];
    case "moves":
      return impact.moves.map(
        (move) =>
          `${plural(move.count, "record")} ${formatValue(names, field, move.from) ?? "empty"} → ${formatValue(names, field, move.to) ?? "empty"}`,
      );
    case "changes":
      return [plural(impact.count, "change")];
  }
}

/**
 * The staged changes' impact, computed from the staged entries alone (no
 * reads): how many records they change and, per column, before → after
 * totals over the changed records (number and money), records moved between
 * values (enum, relation, yes/no) or a change count. Pass the staged log's
 * `names` so related records are named without a second read.
 */
export function ImpactStrip(props: {
  client: CanvasClient;
  session: CanvasSession;
  names?: RecordNames;
}) {
  const { client, session } = props;
  // Only without the log's names does the strip name related records itself.
  const own = useRecordNames(client, {
    sessionId: session.session?.id ?? "",
    asOf: session.session?.as_of ?? null,
    generation: session.generation,
    entries: props.names === undefined ? session.entries : [],
  });
  const names = props.names ?? own;
  const { labels } = names;
  const impacts = useMemo(() => stagedImpact(labels, session.entries), [labels, session.entries]);
  const models = new Set(session.entries.map((entry) => entry.model_id));
  const records = recordsAffected(session.entries);
  return (
    <div
      aria-label="Impact of unsaved changes"
      className="flex flex-col gap-[var(--space-1)] px-[var(--space-4)] py-[var(--space-2-5)] text-[length:var(--text-caption)] leading-[var(--leading-caption)]"
      data-impact-strip
      role="status"
    >
      <span className="text-[var(--color-text-secondary)]">
        <span className="font-[var(--font-weight-semibold)] tabular-nums text-[var(--color-text-primary)]">
          {records}
        </span>{" "}
        {records === 1 ? "record" : "records"} changed
      </span>
      {impacts.map((impact) => {
        const field = labels.fieldById(labels.modelById(impact.model_id), impact.field_id);
        const header = columnHeader(labels, impact.model_id, impact.field_id);
        return (
          <span
            className="flex flex-wrap items-baseline gap-x-[var(--space-2)]"
            data-impact-column={header}
            key={`${impact.model_id}/${impact.field_id}`}
          >
            <span className="text-[var(--color-text-muted)]">
              {models.size > 1 ? `${labels.modelLabel(impact.model_id)} · ` : ""}
              {header}:
            </span>
            {impactLine(names, field, impact).map((line, index) => (
              <Fragment key={line}>
                {index > 0 ? <span className="text-[var(--color-text-disabled)]">·</span> : null}
                <span className="tabular-nums text-[var(--color-text-secondary)]">{line}</span>
              </Fragment>
            ))}
          </span>
        );
      })}
    </div>
  );
}
