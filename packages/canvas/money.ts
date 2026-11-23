/** The period a money value is paid per, after its amount; annual says nothing. */
const periodSuffix: Record<string, string> = {
  annual: "",
  monthly: "/mo",
  weekly: "/wk",
  daily: "/day",
  hourly: "/hr",
};

/**
 * Money as people read it (from the spike's `formatMoney`): the currency's
 * symbol and grouping, whole units for annual amounts (`$150,000`), cents
 * otherwise (`$42.50/hr`). `compact` shortens annual amounts (`$2.4M`) for
 * KPIs and chart axes. Every money value on the canvas goes through this.
 */
export function formatMoney(
  amount: string | number,
  unit: { currency: string; period: string },
  compact = false,
): string {
  const value = Number(amount);
  if (!Number.isFinite(value)) return String(amount);
  // A decimal string formats exactly (Intl reads the string, not a float).
  const exact =
    typeof amount === "string" && /^-?\d+(\.\d+)?$/u.test(amount) ? (amount as `${number}`) : value;
  const annual = unit.period === "annual";
  let text: string;
  try {
    text = new Intl.NumberFormat("en-US", {
      currency: unit.currency,
      // Annual: whole units, or one trimmed decimal compact (`$890K`, `$2.4M`).
      ...(annual ? { minimumFractionDigits: 0 } : {}),
      maximumFractionDigits: annual ? (compact ? 1 : 0) : 2,
      style: "currency",
      ...(compact && annual ? { notation: "compact" as const } : {}),
    }).format(exact);
  } catch {
    // Not an ISO currency code: the amount and the code.
    text = `${value.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${unit.currency}`;
  }
  return `${text}${periodSuffix[unit.period] ?? `/${unit.period}`}`;
}

const numberFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 });

/**
 * A number as people read it: grouped, with at most four decimals. Derived
 * columns arrive as Postgres numeric quotients with ~28 decimals (a
 * compa-ratio of "0.9523809523809523809523809524" reads 0.9524). A decimal
 * string rounds exactly (Intl reads the string, not a float). Derived
 * (read-only) numbers in cells and the record panel go through this; an
 * editable number and the change log keep every digit, so a small edit still
 * reads as a change. The stored value stays the cell's value for sort and copy.
 */
export function formatNumber(raw: string | number): string {
  if (typeof raw === "number") return Number.isFinite(raw) ? numberFormat.format(raw) : String(raw);
  return /^-?\d+(\.\d+)?$/u.test(raw) ? numberFormat.format(raw as `${number}`) : raw;
}
