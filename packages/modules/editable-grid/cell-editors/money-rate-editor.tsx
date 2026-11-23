// AG Grid cellEditor adapter wrapping the design-system MoneyRateEditor leaf.
//
// Mode: POPUP. The leaf renders three controls inline (currency Select,
// amount TextField, period Select) plus a preview line below — that
// horizontal expansion is taller than a single row and wider than typical
// column widths (~150-220px). Inline-in-cell is a non-starter at the column
// widths the headcount table uses; popup mode keeps the layout intact and
// anchors "under" the cell.
//
// Width: the atom carries `min-w-[var(--size-editor-money-rate)]` so AG
// Grid's popup auto-sizing doesn't squash the three-control row down to
// the parent cell width. The popup container has no max-width override —
// AG Grid sizes the popup to the atom's natural width.
//
// Atom-only: the leaf carries no border / shadow chrome itself; this
// adapter wraps it in the panel surface.
//
// Value bridge: this adapter does NOT participate in the
// FieldValue ↔ primitive bridge. The MoneyRate FieldValue carries
// amount + currency + period; the substrate `makeFieldValue("money_rate",
// primitive, prior)` cannot reconstruct the envelope from a single
// primitive (that limitation is documented in
// `packages/engines/field-value-adapter/index.ts`). Instead:
//   - The column declares `valueGetter: ctx.fieldValueGetter(fieldId)` so
//     `params.value` here is the LIVE `FieldValue | null`.
//   - The leaf's `parse` builds the editor's internal shape from the
//     `FieldValue`.
//   - On `onCommit({amount, currency, period})`, we run the leaf's
//     `serialize` to get a fully-formed `FieldValue`, and the column's
//     `valueSetter: ctx.fieldSetterFromValue(fieldId)` writes it via
//     direct `node.setDataValue` into the row + buffer.

import type { ReactElement } from "react";
import type { CustomCellEditorProps } from "ag-grid-react";

import {
  MoneyRateEditor as MoneyRateEditorLeaf,
  moneyRateDefaultCurrencies,
  moneyRateDefaultPeriods,
} from "@autograph/components";
import type { EditorContext, FieldTypeMeta } from "@autograph/components";
import type { FieldValue, VisibleRecord } from "@contracts";

import type { EditorDefaults } from "../schema-columns";
import { fieldTypeMetaFromParams, rowKeyFromParams, type LeafCellEditorParams } from "./shared";

type MoneyRateFieldValue = Extract<FieldValue, { type: "money_rate" }>;

// The leaf starts an empty value on the first currency and period it offers,
// so a row's default goes first (and is offered even when the list lacks it).
const preferring = (preferred: string | undefined, all: readonly string[]) =>
  preferred ? [preferred, ...all.filter((value) => value !== preferred)] : [...all];

export function MoneyRateCellEditorAdapter(
  props: CustomCellEditorProps<unknown, FieldValue> &
    LeafCellEditorParams & { editorDefaults?: (row: VisibleRecord) => EditorDefaults | undefined },
): ReactElement {
  const fieldId = String(props.column.getColId());
  const live = props.value;
  const incoming: MoneyRateFieldValue | undefined =
    live && typeof live === "object" && (live as FieldValue).type === "money_rate"
      ? (live as MoneyRateFieldValue)
      : undefined;
  // Per-row defaults apply only to an empty value; a stored value keeps its unit.
  const defaults =
    !incoming && props.data && props.editorDefaults
      ? props.editorDefaults(props.data as VisibleRecord)
      : undefined;
  const baseType = fieldTypeMetaFromParams(props, "money_rate");
  // Only the list a default names is reordered: the other keeps the leaf's own default.
  const fieldType: FieldTypeMeta = {
    ...baseType,
    ...(defaults?.currency
      ? {
          currencyOptions: preferring(
            defaults.currency,
            baseType.currencyOptions ?? moneyRateDefaultCurrencies,
          ),
        }
      : {}),
    ...(defaults?.period
      ? {
          periodOptions: preferring(
            defaults.period,
            baseType.periodOptions ?? moneyRateDefaultPeriods,
          ),
        }
      : {}),
  };
  const context: EditorContext = { rowKey: rowKeyFromParams(props), fieldId, fieldType };
  const initialValue = MoneyRateEditorLeaf.parse(incoming, context);

  return (
    <div className="rounded-[var(--radius-panel)] border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] shadow-[var(--shadow-raised)]">
      <MoneyRateEditorLeaf.Component
        initialValue={initialValue}
        context={context}
        onCommit={(next) => {
          // An emptied amount is a clear: the column setter stages `null`.
          if (next.amount.trim() === "") {
            props.node.setDataValue(props.column, null, "edit");
            props.api.stopEditing(true);
            return;
          }
          const nextFieldValue = MoneyRateEditorLeaf.serialize(next, context);
          // See text-cell-editor.tsx for the rationale on direct setDataValue.
          // For money_rate the column declares
          // `valueSetter: ctx.fieldSetterFromValue(fieldId)`, which expects
          // a fully-formed `FieldValue` as `params.newValue` (not a primitive).
          props.node.setDataValue(props.column, nextFieldValue, "edit");
          props.api.stopEditing(true);
        }}
        onCancel={() => {
          props.api.stopEditing(true);
        }}
      />
    </div>
  );
}
