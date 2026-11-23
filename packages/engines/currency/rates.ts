import { divideDecimal, formatDecimal } from "../decimal";
import { isIso4217TenderCurrencyCode } from "../reference-data";

/** Effective visible periods, not a version-history log. Both bounds are inclusive. */
export type CurrencyRate = {
  /** Kernel version used for optimistic correction when this period is editable. */
  versionId?: string;
  sourceCurrency: string;
  targetCurrency: string;
  rate: string;
  effectiveStart: string;
  effectiveEnd: string | null;
  origin: "custom" | "frankfurter";
  observationDate?: string;
};
export type CurrencyRateRequest = { sourceCurrency: string; targetCurrency: string; asOf: string };
export type CurrencyRateResolution =
  | {
      status: "found";
      rate: string;
      operation: "multiply" | "divide";
      origin: "identity" | CurrencyRate["origin"];
      entry: CurrencyRate | null;
    }
  | ({ status: "missing" } & CurrencyRateRequest);

export function validateCurrencyDate(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`Invalid currency date: ${value}`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value)
    throw new Error(`Invalid currency date: ${value}`);
}
export function validateCurrencyPair(sourceCurrency: string, targetCurrency: string): void {
  if (!isIso4217TenderCurrencyCode(sourceCurrency) || !isIso4217TenderCurrencyCode(targetCurrency))
    throw new Error(`Invalid currency pair: ${sourceCurrency}/${targetCurrency}`);
}
/** Unordered identity; the quote itself retains its entered source/target direction. */
export function currencyPairKey(
  pair: Pick<CurrencyRateRequest, "sourceCurrency" | "targetCurrency">,
): string {
  return [pair.sourceCurrency, pair.targetCurrency].sort().join("/");
}

function decimal(value: string): { coefficient: bigint; scale: number } {
  if (typeof value !== "string" || !/^[+-]?\d+(?:_?\d)*(?:\.\d+(?:_?\d)*)?$/.test(value))
    throw new Error(`Invalid decimal: ${value}`);
  const [integer, fractionalDigits = ""] = value.replaceAll("_", "").split(".");
  const fraction = fractionalDigits.replace(/0+$/, "");
  const coefficient = BigInt(`${integer}${fraction}`);
  // Match persisted kernel decimal inputs; products below remain exact and unbounded.
  const maximum = 79228162514264337593543950335n;
  if (fraction.length > 28 || coefficient > maximum || coefficient < -maximum) {
    throw new Error("Decimal exceeds kernel precision");
  }
  return { coefficient, scale: fraction.length };
}
export function validateCurrencyRate(rate: CurrencyRate): void {
  validateCurrencyPair(rate.sourceCurrency, rate.targetCurrency);
  validateCurrencyDate(rate.effectiveStart);
  if (rate.effectiveEnd !== null) {
    validateCurrencyDate(rate.effectiveEnd);
    if (rate.effectiveEnd < rate.effectiveStart)
      throw new Error("Currency rate ends before it starts");
  }
  if (rate.observationDate !== undefined) validateCurrencyDate(rate.observationDate);
  if (rate.origin !== "custom" && rate.origin !== "frankfurter")
    throw new Error("Invalid currency rate origin");
  if (decimal(rate.rate).coefficient <= 0n) throw new Error("Currency rate must be positive");
}
export function resolveCurrencyRate(
  rates: readonly CurrencyRate[],
  request: CurrencyRateRequest,
): CurrencyRateResolution {
  validateCurrencyPair(request.sourceCurrency, request.targetCurrency);
  validateCurrencyDate(request.asOf);
  if (request.sourceCurrency === request.targetCurrency)
    return { status: "found", rate: "1", operation: "multiply", origin: "identity", entry: null };
  const active = new Map<CurrencyRate["origin"], CurrencyRate>();
  for (const entry of rates) {
    validateCurrencyRate(entry);
    if (currencyPairKey(entry) !== currencyPairKey(request)) continue;
    if (
      entry.effectiveStart > request.asOf ||
      (entry.effectiveEnd !== null && entry.effectiveEnd < request.asOf)
    )
      continue;
    if (active.has(entry.origin)) throw new Error(`Ambiguous ${entry.origin} currency rates`);
    active.set(entry.origin, entry);
  }
  const entry = active.get("custom") ?? active.get("frankfurter");
  return entry
    ? {
        status: "found",
        rate: entry.rate,
        operation: entry.sourceCurrency === request.sourceCurrency ? "multiply" : "divide",
        origin: entry.origin,
        entry,
      }
    : { status: "missing", ...request };
}
/** Display the effective timeline: automatic periods only occupy gaps in custom coverage. */
export function effectiveCurrencyPeriods(
  rates: readonly CurrencyRate[],
  pair: Pick<CurrencyRateRequest, "sourceCurrency" | "targetCurrency">,
): CurrencyRate[] {
  const matching = rates.filter((rate) => currencyPairKey(rate) === currencyPairKey(pair));
  const custom = matching.filter((rate) => rate.origin === "custom");
  const lastDay = "9999-12-31";
  function adjacentDay(value: string, offset: number) {
    const date = new Date(`${value}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + offset);
    return date.toISOString().slice(0, 10);
  }
  return matching
    .flatMap((rate) => {
      if (rate.origin === "custom") return [rate];
      let gaps = [rate];
      for (const override of custom) {
        gaps = gaps.flatMap((gap) => {
          const end = gap.effectiveEnd ?? lastDay;
          const overrideEnd = override.effectiveEnd ?? lastDay;
          if (override.effectiveStart > end || overrideEnd < gap.effectiveStart) return [gap];
          const remaining: CurrencyRate[] = [];
          if (gap.effectiveStart < override.effectiveStart)
            remaining.push({ ...gap, effectiveEnd: adjacentDay(override.effectiveStart, -1) });
          if (overrideEnd < end)
            remaining.push({ ...gap, effectiveStart: adjacentDay(overrideEnd, 1) });
          return remaining;
        });
      }
      return gaps;
    })
    .toSorted((a, b) => b.effectiveStart.localeCompare(a.effectiveStart));
}

export type CurrencyConversion =
  | (Extract<CurrencyRateResolution, { status: "found" }> & { amount: string })
  | Extract<CurrencyRateResolution, { status: "missing" }>;

/** Exact multiplication/division when terminating; repeating division uses 28 significant digits, half-even. */
export function convertCurrency(
  amount: string,
  rates: readonly CurrencyRate[],
  request: CurrencyRateRequest,
): CurrencyConversion {
  const input = decimal(amount);
  const resolution = resolveCurrencyRate(rates, request);
  if (resolution.status === "missing") return resolution;
  const multiplier = decimal(resolution.rate);
  if (resolution.operation === "divide") {
    // Validated rates are positive, so the quotient is never null.
    return { ...resolution, amount: formatDecimal(divideDecimal(input, multiplier)!) };
  }
  return {
    ...resolution,
    amount: formatDecimal({
      coefficient: input.coefficient * multiplier.coefficient,
      scale: input.scale + multiplier.scale,
    }),
  };
}
