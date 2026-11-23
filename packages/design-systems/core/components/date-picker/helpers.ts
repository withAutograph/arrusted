/*
 * Pure date helpers copied verbatim from
 * Source date-picker behavior.
 *
 * No JSX, no class names, no design-system tokens — only string parsing,
 * clamping, and `Date` construction. Component code in `index.tsx` and
 * `month-year-selector.tsx` consumes these.
 */

export const YEAR_GRID_BLOCK = 12;
export const MIN_YEAR = 1;
export const MAX_YEAR = 9999;
export const MAX_YEAR_RANGE_START = MAX_YEAR - YEAR_GRID_BLOCK + 1;

export type LocalDateString = `${number}-${number}-${number}`;

export const MONTH_OPTIONS = Array.from({ length: 12 }, (_, monthIndex) => {
  const sampleDate = new Date(2020, monthIndex, 1);
  return {
    index: monthIndex,
    shortLabel: sampleDate.toLocaleDateString(undefined, { month: "short" }),
    fullLabel: sampleDate.toLocaleDateString(undefined, { month: "long" }),
  };
});

const DISPLAY_DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "2-digit",
  year: "numeric",
});

export const DISPLAY_MONTH_INDEX_BY_SHORT_LABEL: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

export function parseISODate(value?: string) {
  if (!value) return undefined;
  const normalized = normalizeDateSeparators(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return undefined;
  const date = new Date(`${normalized}T00:00:00`);
  if (Number.isNaN(date.getTime())) return undefined;
  if (toIsoDateString(date) !== normalized) return undefined;
  if (!isSupportedYear(date.getFullYear())) return undefined;
  return date;
}

export function parseDateInput(value?: string) {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const normalized = normalizeDateSeparators(trimmed);
  const isoDate = parseISODate(normalized);
  if (isoDate) return isoDate;
  return parseDisplayDate(trimmed);
}

export function deriveVisibleMonth(value: string) {
  if (!value) return undefined;
  const fullDate = parseDateInput(value);
  if (fullDate) return startOfMonth(fullDate);

  const normalized = normalizeDateSeparators(value);
  const monthMatch = normalized.match(/^(\d{4})-(\d{2})$/);
  if (monthMatch) {
    const [, year, month] = monthMatch;
    const numericMonth = Number(month) - 1;
    if (numericMonth >= 0 && numericMonth < 12 && isSupportedYear(Number(year))) {
      const date = localDate(Number(year), numericMonth, 1);
      if (!Number.isNaN(date.getTime())) {
        return startOfMonth(date);
      }
    }
  }

  const yearMatch = normalized.match(/^(\d{4})$/);
  if (yearMatch) {
    const year = Number(yearMatch[1]);
    if (isSupportedYear(year)) {
      return startOfMonth(localDate(year, 0, 1));
    }
  }

  return undefined;
}

// Years the picker can show and its year selector can offer.
function isSupportedYear(year: number) {
  return Number.isInteger(year) && year >= MIN_YEAR && year <= MAX_YEAR;
}

// A local calendar date. `new Date(year, ...)` maps years 0-99 to 1900-1999,
// so the year is set separately; the picker works in local dates throughout.
export function localDate(year: number, monthIndex: number, day: number) {
  const date = new Date(2000, monthIndex, day);
  date.setFullYear(year, monthIndex, day);
  return date;
}

export function startOfMonth(date: Date) {
  return localDate(date.getFullYear(), date.getMonth(), 1);
}

export function isSameMonth(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
}

export function normalizeDateSeparators(value: string) {
  return value.replaceAll("/", "-");
}

export function parseDisplayDate(value: string) {
  const match = value.match(/^([A-Za-z]{3})\s+(\d{1,2}),\s*(\d{4})$/);
  if (!match) return undefined;

  const monthKey = match[1]!.toLowerCase();
  const monthIndex = DISPLAY_MONTH_INDEX_BY_SHORT_LABEL[monthKey];
  if (monthIndex == null) return undefined;

  const day = Number.parseInt(match[2]!, 10);
  const year = Number.parseInt(match[3]!, 10);
  if (!Number.isFinite(day) || !isSupportedYear(year)) return undefined;

  const date = localDate(year, monthIndex, day);
  if (Number.isNaN(date.getTime())) return undefined;
  if (date.getFullYear() !== year) return undefined;
  if (date.getMonth() !== monthIndex) return undefined;
  if (date.getDate() !== day) return undefined;
  return date;
}

export function normalizeBoundDate(value?: string) {
  const raw = (value ?? "").trim();
  if (!raw) return undefined;

  // Accept ISO-ish date time strings by taking the leading YYYY-MM-DD portion
  const leadingIsoMatch = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (leadingIsoMatch) {
    const parsed = parseISODate(leadingIsoMatch[1]);
    return parsed ? toIsoDateString(parsed) : undefined;
  }

  // Best-effort parse for other formats
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) return undefined;
  return toIsoDateString(new Date(parsed));
}

export function clampISODateString(value: string, minDate?: string, maxDate?: string) {
  const next = (value ?? "").trim();
  if (!next) return "";
  if (minDate && next < minDate) return minDate;
  if (maxDate && next > maxDate) return maxDate;
  return next;
}

export function toIsoDateString(date: Date) {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function formatDateForDisplay(value: string) {
  const parsed = parseISODate(value);
  if (!parsed) {
    return value;
  }
  return DISPLAY_DATE_FORMATTER.format(parsed);
}

export function deriveYearRangeStart(year: number) {
  return year - Math.floor(YEAR_GRID_BLOCK / 2);
}

export function clampYearRangeStart(value: number) {
  if (Number.isNaN(value) || !Number.isFinite(value)) {
    return MIN_YEAR;
  }
  const lowerBound = MIN_YEAR;
  const upperBound = Math.max(MIN_YEAR, MAX_YEAR_RANGE_START);
  const clampedValue = Math.min(Math.max(value, lowerBound), upperBound);
  return Number.isNaN(clampedValue) ? lowerBound : clampedValue;
}

export function formatMonthLabel(date: Date) {
  return date.toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });
}
