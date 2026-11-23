import {
  validateCurrencyDate,
  validateCurrencyPair,
  validateCurrencyRate,
  type CurrencyRate,
} from "../engines/currency/rates";

/** Preparation only. Never called by rate resolution or conversion. */
export async function fetchFrankfurterMonthlyRate(
  input: { sourceCurrency: string; targetCurrency: string; month: string },
  options: { fetch?: typeof fetch; today?: string; signal?: AbortSignal } = {},
): Promise<CurrencyRate | null> {
  validateCurrencyPair(input.sourceCurrency, input.targetCurrency);
  if (!/^\d{4}-\d{2}$/.test(input.month)) throw new Error("Month must be YYYY-MM");
  const effectiveStart = `${input.month}-01`;
  validateCurrencyDate(effectiveStart);
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  validateCurrencyDate(today);
  if (effectiveStart > today) throw new Error("Cannot import a future monthly observation");
  if (input.sourceCurrency === input.targetCurrency) return null;
  const url = new URL(
    `https://api.frankfurter.dev/v2/rate/${input.sourceCurrency}/${input.targetCurrency}`,
  );
  url.searchParams.set("date", effectiveStart);
  const response = await (options.fetch ?? fetch)(url, {
    signal: options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(15_000)])
      : AbortSignal.timeout(15_000),
    headers: { accept: "application/json" },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Frankfurter request failed (${response.status})`);
  // Node 24 / Bun preserve numeric token spelling via the JSON reviver context.
  // Do not pass provider decimals through binary floating-point arithmetic.
  const data: unknown = JSON.parse(
    await response.text(),
    function (key, value, context?: { source: string }) {
      if (key !== "rate" || typeof value !== "number") return value;
      if (!context?.source) throw new Error("Lossless JSON number parsing is required");
      return context.source;
    },
  );
  if (typeof data !== "object" || data === null || Array.isArray(data))
    throw new Error("Invalid Frankfurter response");
  const row = data as Record<string, unknown>;
  if (
    row.base !== input.sourceCurrency ||
    row.quote !== input.targetCurrency ||
    typeof row.date !== "string" ||
    typeof row.rate !== "string"
  ) {
    throw new Error("Frankfurter response does not match the requested currency pair");
  }
  validateCurrencyDate(row.date);
  if (row.date > effectiveStart)
    throw new Error("Frankfurter returned an observation after the reference date");
  const rate: CurrencyRate = {
    sourceCurrency: input.sourceCurrency,
    targetCurrency: input.targetCurrency,
    rate: expandDecimal(row.rate),
    effectiveStart,
    effectiveEnd: null,
    origin: "frankfurter",
    observationDate: row.date,
  };
  validateCurrencyRate(rate);
  return rate;
}

function expandDecimal(value: string): string {
  const match = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(value);
  if (!match) throw new Error("Invalid provider decimal");
  const exponent = Number(match[3] ?? 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 28)
    throw new Error("Provider decimal is outside supported precision");
  const integer = match[1]!;
  const digits = integer + (match[2] ?? "");
  const point = integer.length + exponent;
  return point <= 0
    ? `0.${"0".repeat(-point)}${digits}`
    : point >= digits.length
      ? digits + "0".repeat(point - digits.length)
      : `${digits.slice(0, point)}.${digits.slice(point)}`;
}
