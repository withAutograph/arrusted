import { useMemo, useRef, useState } from "react";
import type { FieldValue } from "@contracts";

// Relative import (not `@engines/format`): the `mise run test:app`
// runner uses Bun without a tsconfig path resolver, so the alias fails to
// load at module-eval time. Keep the relative path until the test runner
// gets alias support.
import { formatCompactCurrency, formatCompactPercent } from "../../../../../engines/format";
import { Select, TextField } from "../../FormControls";
import { cx } from "../../utils";
import type { EditorContext, EditorProps, FieldEditor } from "../protocol";
import {
  decimalToScaled,
  formatMoneyRateDisplay,
  isZero,
  parseMoneyRateExpression,
  scaleCoefficient,
  scaledDecimalToString,
  type ParseExpressionResult,
} from "./math";

export * from "./math";

type MoneyRatePeriod = "hourly" | "daily" | "weekly" | "monthly" | "annual";

export type MoneyRateEditValue = {
  currency: string;
  amount: string;
  period: MoneyRatePeriod;
  /** Frozen amount captured at parse time for relative math (delta / percent). */
  initialAmount: string;
};

export type MoneyRateCommitValue = { currency: string; amount: string; period: MoneyRatePeriod };

const DEFAULT_CURRENCIES = ["USD", "CAD", "EUR", "GBP"];
const DEFAULT_PERIODS: MoneyRatePeriod[] = ["hourly", "daily", "weekly", "monthly", "annual"];
/** The currencies and periods offered when the field type names none. */
export const moneyRateDefaultCurrencies: readonly string[] = DEFAULT_CURRENCIES;
export const moneyRateDefaultPeriods: readonly string[] = DEFAULT_PERIODS;
const PERIOD_LABEL: Record<MoneyRatePeriod, string> = {
  hourly: "hr",
  daily: "day",
  weekly: "wk",
  monthly: "mo",
  annual: "yr",
};

function isMoneyRatePeriod(value: string): value is MoneyRatePeriod {
  return DEFAULT_PERIODS.includes(value as MoneyRatePeriod);
}

type MoneyRateEditorProps = EditorProps<MoneyRateEditValue, MoneyRateCommitValue> & {
  initialQuery?: string;
};

function MoneyRateEditorComponent(props: MoneyRateEditorProps) {
  const { initialValue, context, initialQuery, onCancel, onCommit, onNavigate } = props;
  const initialAmount = initialValue.initialAmount;
  const initialDisplayAmount = formatMoneyRateDisplay(
    initialValue.amount || "0",
    initialValue.currency,
  );

  const currencyOptions = (context.fieldType.currencyOptions ?? DEFAULT_CURRENCIES).map(
    (value) => ({ value, label: value }),
  );
  const periodOptions = (context.fieldType.periodOptions ?? DEFAULT_PERIODS).flatMap((value) =>
    isMoneyRatePeriod(value) ? [{ value, label: PERIOD_LABEL[value] }] : [],
  );

  const [currency, setCurrency] = useState(initialValue.currency);
  const [period, setPeriod] = useState<MoneyRatePeriod>(initialValue.period);
  const [amountInput, setAmountInput] = useState(initialQuery ?? initialValue.amount ?? "");
  const finishedRef = useRef(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const errorId = `${context.fieldId}-money-rate-error`;
  const amountLabel = context.fieldType.label
    ? `${context.fieldType.label} amount`
    : "Money rate amount";

  const parseResult = useMemo<ParseExpressionResult | null>(() => {
    if (amountInput.trim().length === 0) return null;
    return parseMoneyRateExpression(amountInput, initialAmount || "0");
  }, [amountInput, initialAmount]);

  const computedAmount = parseResult && parseResult.ok ? parseResult.value : null;
  const computedDisplay = computedAmount ? formatCompactCurrency(computedAmount, currency) : null;
  const deltaDisplay = useMemo(() => {
    if (!computedAmount) return null;
    const baseScaled = decimalToScaled(initialAmount);
    const newScaled = decimalToScaled(computedAmount);
    if (!baseScaled || !newScaled || isZero(baseScaled)) return null;
    const scale = Math.max(baseScaled.scale, newScaled.scale);
    const deltaCoef = scaleCoefficient(newScaled, scale) - scaleCoefficient(baseScaled, scale);
    if (deltaCoef === 0n) return null;
    const negative = deltaCoef < 0n;
    const absString = scaledDecimalToString(negative ? -deltaCoef : deltaCoef, scale);
    if (!absString) return null;
    const deltaString = negative ? `-${absString}` : absString;
    const percent =
      ((Number(computedAmount) - Number(initialAmount)) / Number(initialAmount)) * 100;
    return {
      amount: formatCompactCurrency(deltaString, currency, { signed: true }),
      percent: formatCompactPercent(percent, { signed: true }),
    };
  }, [computedAmount, currency, initialAmount]);
  const isEmpty = amountInput.trim().length === 0;
  const isInvalid = parseResult !== null && !parseResult.ok;
  const showPreview = (() => {
    if (parseResult === null || (computedAmount === null && !isInvalid)) return false;
    if (isInvalid) return true;
    const trimmed = amountInput.trim();
    if (computedAmount === (initialValue.amount || "") && trimmed === (initialValue.amount || ""))
      return false;
    if (computedAmount && trimmed === formatMoneyRateDisplay(computedAmount, currency))
      return false;
    return true;
  })();

  function commit(opts: { emptyNoopAction?: "cancel" | "none" } = {}) {
    if (finishedRef.current) return false;
    const cancelOnNoop = opts.emptyNoopAction !== "none";
    const sameMeta = currency === initialValue.currency && period === initialValue.period;
    const finish = (action: () => void) => {
      finishedRef.current = true;
      action();
      return true;
    };

    if (isEmpty) {
      // Emptying a stored amount on a field the host marks optional commits an
      // empty amount, which the host treats as clearing the value.
      if (context.fieldType.required === false && (initialValue.amount ?? "").trim().length > 0) {
        return finish(() => onCommit({ amount: "", currency, period }));
      }
      if (sameMeta || (initialValue.amount ?? "").trim().length === 0) {
        return finish(() => {
          if (cancelOnNoop) onCancel();
        });
      }
      return finish(() => onCommit({ amount: initialValue.amount, currency, period }));
    }
    if (parseResult === null || !parseResult.ok) return false;
    const nextAmount = parseResult.value;
    // Same-amount detection. Strict-string check first so an unchanged
    // textfield short-circuits; fall back to scaled-bigint equality so a
    // parser-normalized "155000.00" → "155000" round-trip (the user
    // clicked into the cell and out without typing) doesn't fire a
    // false-dirty. Number() would flatten "1.00" and "1.000" to the
    // same float and drop legitimate precision-only edits; bigint
    // comparison at the max of the two scales is precision-preserving.
    // Both inputs went through `parseMoneyRateExpression.ok`, so
    // `decimalToScaled` won't return null here; we keep the null-guard
    // for defense-in-depth and fall through to "not equal" if it does
    // (treating an unparseable string as a real edit is the safer side
    // — the kernel will reject obviously bad numbers, but it never
    // silently drops a user edit).
    const initialAmountStr = initialValue.amount || "";
    let sameAmount = nextAmount === initialAmountStr;
    if (!sameAmount && initialAmountStr !== "") {
      const nextScaled = decimalToScaled(nextAmount);
      const initScaled = decimalToScaled(initialAmountStr);
      if (nextScaled && initScaled) {
        const scale = Math.max(nextScaled.scale, initScaled.scale);
        sameAmount = scaleCoefficient(nextScaled, scale) === scaleCoefficient(initScaled, scale);
      }
    }
    if (sameAmount && sameMeta) {
      return finish(() => {
        if (cancelOnNoop) onCancel();
      });
    }
    return finish(() => onCommit({ amount: nextAmount, currency, period }));
  }

  function cancel() {
    if (finishedRef.current) return;
    finishedRef.current = true;
    onCancel();
  }

  return (
    <div
      ref={rootRef}
      // Atom-only: no outer border / shadow / card chrome — the consumer
      // (AG Grid popup, sheet form popover) provides the surface. The
      // `min-w-[var(--size-editor-money-rate)]` ensures the three-control row
      // has horizontal room when the consumer doesn't dictate width (e.g.
      // AG Grid's popup auto-sizes to the cell width otherwise).
      className="flex min-w-[var(--size-editor-money-rate)] flex-col gap-[var(--space-1)] p-[var(--space-2)]"
      onBlur={(event) => {
        const nextFocus = event.relatedTarget;
        if (nextFocus instanceof Node && rootRef.current?.contains(nextFocus)) return;
        void commit();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          cancel();
        }
      }}
    >
      <div className="inline-flex items-center gap-[var(--space-2)]">
        <Select
          aria-label={context.fieldType.label ? `${context.fieldType.label} currency` : "Currency"}
          size="xs"
          value={currency}
          options={currencyOptions}
          onValueChange={setCurrency}
        />
        <TextField
          autoFocus
          className={cx(
            "w-[var(--size-editor-amount)] text-left tabular-nums",
            isInvalid && "border-[var(--color-status-danger)]",
          )}
          aria-describedby={isInvalid ? errorId : undefined}
          aria-invalid={isInvalid || undefined}
          aria-label={amountLabel}
          inputMode="text"
          placeholder={initialDisplayAmount}
          size="xs"
          value={amountInput}
          onKeyDown={(event) => {
            // stopPropagation so the AG Grid v33 cell-bound listener doesn't
            // race React (see `docs/known-footguns.md` "Editable Grid Host" —
            // the popup tears down on AG Grid's Enter handler before React's
            // synthetic onKeyDown can fire on the input).
            if (event.key === "Enter") {
              event.preventDefault();
              event.stopPropagation();
              void commit();
            } else if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              cancel();
            } else if (event.key === "Tab") {
              if (!onNavigate) return;
              event.preventDefault();
              event.stopPropagation();
              if (commit({ emptyNoopAction: "none" }))
                onNavigate(event.shiftKey ? "previous" : "next");
            }
          }}
          onValueChange={setAmountInput}
        />
        <Select
          size="xs"
          value={period}
          options={periodOptions}
          aria-label={context.fieldType.label ? `${context.fieldType.label} period` : "Period"}
          onValueChange={(next) => {
            if (isMoneyRatePeriod(next)) setPeriod(next);
          }}
        />
      </div>
      {/* Preview uses compact (rounded) display; the committed value is the
          full-precision parse result. Visual drift between preview and the
          eventual mainline cell is intentional and bounded to compact rounding. */}
      {showPreview ? (
        isInvalid ? (
          <div
            id={errorId}
            role="alert"
            className="inline-flex items-baseline gap-[var(--space-1)] text-[length:var(--text-micro)] text-[var(--color-status-danger)] tabular-nums"
          >
            <span aria-hidden="true">&#9888;</span>
            <span>can&apos;t read that</span>
          </div>
        ) : (
          <div
            aria-live="polite"
            className="inline-flex items-baseline gap-[var(--space-1)] text-[length:var(--text-micro)] text-[var(--color-text-secondary)] tabular-nums"
          >
            <span aria-hidden="true" className="text-[var(--color-text-disabled)]">
              &#8627;
            </span>
            <span>
              {computedDisplay}
              {deltaDisplay ? ` (${deltaDisplay.amount}, ${deltaDisplay.percent})` : null}
            </span>
          </div>
        )
      ) : null}
    </div>
  );
}

export const MoneyRateEditor: FieldEditor<
  MoneyRateEditValue,
  Extract<FieldValue, { type: "money_rate" }>,
  MoneyRateCommitValue
> = {
  Component: MoneyRateEditorComponent,
  mode: "inline",
  parse: (fieldValue, ctx) => {
    const defaultCurrency = ctx.fieldType.currencyOptions?.[0] ?? "USD";
    const defaultPeriodRaw = ctx.fieldType.periodOptions?.[0] ?? "annual";
    const defaultPeriod: MoneyRatePeriod = isMoneyRatePeriod(defaultPeriodRaw)
      ? defaultPeriodRaw
      : "annual";
    if (!fieldValue) {
      return { currency: defaultCurrency, amount: "", period: defaultPeriod, initialAmount: "0" };
    }
    const period: MoneyRatePeriod = isMoneyRatePeriod(fieldValue.value.period)
      ? fieldValue.value.period
      : defaultPeriod;
    return {
      currency: fieldValue.value.currency,
      amount: fieldValue.value.amount,
      period,
      initialAmount: fieldValue.value.amount,
    };
  },
  serialize: (uiValue, _ctx: EditorContext) => ({
    type: "money_rate",
    value: { amount: uiValue.amount, currency: uiValue.currency, period: uiValue.period },
  }),
};
