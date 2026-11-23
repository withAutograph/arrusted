import type { Field, FieldValue, RecordKey } from "@contracts";

// Locale-pinned for stable output across environments; tests assert against
// the en-US Intl strings.
const FORMAT_LOCALE = "en-US";
const COMPACT_CURRENCY_FORMATTERS = new Map<string, Intl.NumberFormat>();
const COMPACT_PERCENT_FORMATTERS = new Map<string, Intl.NumberFormat>();

export type CompactCurrencyOptions = {
  /** Significant figures. Default 3. */
  sigFigs?: number;
  /** Show "+" prefix for positive values. Default false. */
  signed?: boolean;
};

export function formatCompactCurrency(
  amount: string,
  currency: string,
  options?: CompactCurrencyOptions,
): string {
  if (typeof amount !== "string" || amount.trim().length === 0) {
    return "";
  }
  const value = Number(amount);
  if (!Number.isFinite(value)) {
    return "";
  }
  const sigFigs = options?.sigFigs ?? 3;
  const formatterKey = `${currency}:${sigFigs}`;
  let formatter = COMPACT_CURRENCY_FORMATTERS.get(formatterKey);
  if (!formatter) {
    formatter = new Intl.NumberFormat(FORMAT_LOCALE, {
      style: "currency",
      currency,
      notation: "compact",
      maximumSignificantDigits: sigFigs,
    });
    COMPACT_CURRENCY_FORMATTERS.set(formatterKey, formatter);
  }
  const formatted = formatter.format(value);
  if (options?.signed && value > 0) {
    return `+${formatted}`;
  }
  return formatted;
}

const MONEY_RATE_PERIOD_SUFFIX: Record<string, string> = {
  hourly: "hr",
  daily: "day",
  weekly: "wk",
  monthly: "mo",
  annual: "yr",
};

export function formatMoneyRatePeriod(period: string): string {
  return MONEY_RATE_PERIOD_SUFFIX[period] ?? period;
}

export function formatCompactMoneyRate(amount: string, currency: string, period: string): string {
  const compact = formatCompactCurrency(amount, currency);
  return compact ? `${compact}/${formatMoneyRatePeriod(period)}` : "";
}

const MONTHS_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

export function formatIsoDateLong(iso: string): string {
  // ISO date `YYYY-MM-DD`. Parse without `new Date()` so local timezones
  // cannot shift date-only values by a day.
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const [, y, mm, dd] = m;
  const monthIdx = Number(mm) - 1;
  if (monthIdx < 0 || monthIdx > 11) return iso;
  const day = Number(dd);
  const year = Number(y);
  const maxDay = new Date(Date.UTC(year, monthIdx + 1, 0)).getUTCDate();
  if (day < 1 || day > maxDay) return iso;
  return `${MONTHS_SHORT[monthIdx]} ${day}, ${y}`;
}

export type FormatFieldOptions = {
  relationLabel?: (
    key: RecordKey,
    field: Pick<Field, "id" | "label" | "type">,
  ) => string | null | undefined;
};

export function formatField(
  value: FieldValue | null | undefined,
  field: Pick<Field, "id" | "label" | "type" | "option_set">,
  options: FormatFieldOptions = {},
): string {
  if (value == null) return "";
  switch (value.type) {
    case "text":
    case "number":
      return String(value.value);
    case "date":
      return formatIsoDateLong(String(value.value));
    case "datetime":
      return String(value.value);
    case "bool":
      return value.value ? "Yes" : "No";
    case "money_rate":
      return formatCompactMoneyRate(value.value.amount, value.value.currency, value.value.period);
    case "relation": {
      const label = options.relationLabel?.(value.value, field);
      return label ?? recordKeyDisplayValue(value.value);
    }
    case "relation_list":
      return value.value
        .map((key) => options.relationLabel?.(key, field) ?? recordKeyDisplayValue(key))
        .join(", ");
    case "text_list":
      return value.value.join(", ");
    case "enum":
      return field.option_set?.find((option) => option.id === value.value)?.label ?? value.value;
    case "json":
      try {
        return JSON.stringify(value.value);
      } catch {
        return "";
      }
    case "schema_lifecycle":
      return value.value === "active" ? "Active" : "Retired";
  }
}

function recordKeyDisplayValue(key: RecordKey): string {
  return key.type === "lookup_or_create" ? key.value.label : key.value;
}

export type CompactPercentOptions = {
  /** Show "+" prefix for positive values. Default false. */
  signed?: boolean;
  /** Max fractional digits. Default 1. */
  maxFractionDigits?: number;
};

export function formatCompactPercent(value: number, options?: CompactPercentOptions): string {
  if (!Number.isFinite(value)) {
    return "";
  }
  // Display-only: percent inputs originate from in-UI numeric math (deltas
  // bounded to fit human-readable copy), so JS `number` precision is fine.
  // Persisted decimals always travel as strings (`docs/contracts.md` row-version
  // typed columns); never feed a persisted amount through this without first
  // computing the percent yourself.
  const maxFractionDigits = options?.maxFractionDigits ?? 1;
  let formatter = COMPACT_PERCENT_FORMATTERS.get(String(maxFractionDigits));
  if (!formatter) {
    formatter = new Intl.NumberFormat(FORMAT_LOCALE, {
      style: "percent",
      maximumFractionDigits: maxFractionDigits,
    });
    COMPACT_PERCENT_FORMATTERS.set(String(maxFractionDigits), formatter);
  }
  const formatted = formatter.format(value / 100);
  if (options?.signed && value > 0) {
    return `+${formatted}`;
  }
  return formatted;
}
