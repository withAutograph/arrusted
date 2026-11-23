/*
 * DatePickerCalendar — the calendar surface of the date picker, factored out
 * so other components (AsOfDatePill, future range pickers) can embed the same
 * day grid + month/year drill-down without an input trigger.
 *
 * The standalone DatePicker (in `./index.tsx`) wraps this in an input + popover
 * shell. AsOfDatePill embeds it directly in its own popover, with no input.
 */
import { type CaptionLabelProps, type ClassNames, type Matcher, DayPicker } from "react-day-picker";
import { useCallback, useEffect, useMemo, useState } from "react";

import { cx } from "../utils";
import {
  clampISODateString,
  deriveVisibleMonth,
  formatMonthLabel,
  isSameMonth,
  normalizeBoundDate,
  parseISODate,
  startOfMonth,
  toIsoDateString,
} from "./helpers";
import { MonthYearSelector } from "./month-year-selector";
import { NAV_BUTTON_CLASSES } from "./styles";

const DAY_BUTTON_CLASSES = cx(
  "flex h-[var(--size-date-cell)] w-[var(--size-date-cell)] items-center justify-center",
  "rounded-[var(--radius-control)] text-[length:var(--text-control-xs)] font-[var(--font-weight-medium)]",
  "tabular-nums text-[var(--color-text-primary)] transition-all",
  "focus-visible:outline-none",
  "hover:bg-[var(--color-bg-selected)] hover:text-[var(--color-action-primary)]",
  "data-[disabled=true]:cursor-not-allowed data-[disabled=true]:opacity-40",
  "data-[disabled=true]:hover:bg-transparent data-[disabled=true]:hover:text-[var(--color-text-muted)]",
  "group-data-[disabled=true]:cursor-not-allowed group-data-[disabled=true]:opacity-40",
  "group-data-[disabled=true]:hover:bg-transparent group-data-[disabled=true]:hover:text-[var(--color-text-muted)]",
  "data-[outside=true]:text-[var(--color-text-muted)] group-data-[outside=true]:text-[var(--color-text-muted)]",
  "data-[selected=true]:bg-[var(--color-action-primary)] data-[selected=true]:text-[var(--color-text-inverse)]",
  "data-[selected=true]:shadow-[var(--shadow-control)]",
  "data-[selected=true]:hover:bg-[var(--color-action-primary)] data-[selected=true]:hover:text-[var(--color-text-inverse)]",
  "group-data-[selected=true]:bg-[var(--color-action-primary)] group-data-[selected=true]:text-[var(--color-text-inverse)]",
  "group-data-[selected=true]:shadow-[var(--shadow-control)]",
  "group-data-[selected=true]:hover:bg-[var(--color-action-primary)] group-data-[selected=true]:hover:text-[var(--color-text-inverse)]",
  "data-[today=true]:text-[var(--color-action-primary)] data-[today=true]:font-[var(--font-weight-semibold)]",
);

const DAY_PICKER_CLASS_NAMES = {
  root: "flex h-full w-full flex-col select-none bg-[var(--color-bg-surface)] text-[var(--color-text-primary)] text-[length:var(--text-control-xs)]",
  months: "flex flex-1 px-[var(--space-4)] pb-[var(--space-4)] pt-[var(--space-3)]",
  month:
    "grid h-full w-full grid-cols-[var(--layout-date-picker-month)] grid-rows-[auto_1fr] items-start gap-y-[var(--space-3)]",
  month_caption: "col-start-2 row-start-1 flex items-center justify-center text-center",
  caption_label:
    "text-[length:var(--text-control-sm)] font-[var(--font-weight-medium)] text-[var(--color-text-primary)]",
  nav: "flex items-center justify-between px-[var(--space-4)] pb-[var(--space-2)] pt-[var(--space-3)] text-[var(--color-text-primary)]",
  button_previous: cx(NAV_BUTTON_CLASSES, "col-start-1 row-start-1 justify-self-start"),
  button_next: cx(NAV_BUTTON_CLASSES, "col-start-3 row-start-1 justify-self-end"),
  chevron: "h-[var(--size-icon-sm)] w-[var(--size-icon-sm)]",
  month_grid:
    "col-span-3 row-start-2 h-full w-full border-separate border-spacing-x-[var(--space-1)] border-spacing-y-[var(--space-1)] text-[length:var(--text-control-xs)] text-[var(--color-text-primary)]",
  weekdays:
    "text-[length:var(--text-micro)] font-[var(--font-weight-medium)] uppercase tracking-[var(--tracking-micro)] text-[var(--color-text-muted)]",
  weekday:
    "pb-[var(--space-1)] text-center text-[length:var(--text-micro)] font-[var(--font-weight-medium)] uppercase tracking-[var(--tracking-micro)] text-[var(--color-text-muted)]",
  week: "text-center align-middle",
  weeks: "",
  day: "group relative p-[var(--space-0)] text-center text-[length:var(--text-control-xs)] align-middle",
  day_button: DAY_BUTTON_CLASSES,
} satisfies Partial<ClassNames>;

export type DatePickerCalendarProps = {
  /** Currently-selected date as ISO YYYY-MM-DD. Empty string for no selection. */
  value: string;
  /** Fired when the user picks a day. Receives an ISO date or "" for clear. */
  onSelect: (value: string) => void;
  /** Inclusive lower bound (YYYY-MM-DD). Days before are disabled and clamped on commit. */
  minDate?: string;
  /** Inclusive upper bound (YYYY-MM-DD). Days after are disabled and clamped on commit. */
  maxDate?: string;
  /** Controlled visible month. When omitted, the calendar manages its own. */
  month?: Date;
  onMonthChange?: (month: Date) => void;
  className?: string;
};

export function DatePickerCalendar(props: DatePickerCalendarProps) {
  const { value, onSelect, minDate, maxDate, month: monthProp, onMonthChange, className } = props;

  const [internalMonth, setInternalMonth] = useState<Date>(
    () => deriveVisibleMonth(value ?? "") ?? startOfMonth(new Date()),
  );
  const isMonthControlled = monthProp !== undefined;
  const currentMonth = isMonthControlled ? monthProp : internalMonth;

  function setCurrentMonth(next: Date) {
    const normalized = startOfMonth(next);
    if (isMonthControlled) {
      onMonthChange?.(normalized);
    } else {
      setInternalMonth(normalized);
    }
  }
  const [isSelectingMonthYear, setIsSelectingMonthYear] = useState(false);

  const normalizedMinDate = useMemo(() => normalizeBoundDate(minDate), [minDate]);
  const normalizedMaxDate = useMemo(() => normalizeBoundDate(maxDate), [maxDate]);
  const disabledDayRules = useMemo<Matcher[] | undefined>(() => {
    const rules: Matcher[] = [];
    const min = parseISODate(normalizedMinDate);
    const max = parseISODate(normalizedMaxDate);
    if (min) rules.push({ before: min });
    if (max) rules.push({ after: max });
    return rules.length ? rules : undefined;
  }, [normalizedMinDate, normalizedMaxDate]);

  const selectedDate = useMemo(() => parseISODate(value), [value]);

  useEffect(() => {
    if (isMonthControlled) return;
    const monthFromValue = deriveVisibleMonth(value ?? "");
    if (!monthFromValue) return;
    setInternalMonth((previous) =>
      isSameMonth(previous, monthFromValue) ? previous : startOfMonth(monthFromValue),
    );
  }, [value, isMonthControlled]);

  function handleSelect(date: Date | undefined) {
    if (!date) {
      onSelect("");
      return;
    }
    const clamped = clampISODateString(toIsoDateString(date), normalizedMinDate, normalizedMaxDate);
    onSelect(clamped);
  }

  // Memoized so the components prop identity is stable across renders; without
  // this, react-day-picker remounts the caption every render and the popover
  // loses its hover/focus state mid-interaction.
  const captionLabelComponent = useCallback(
    function CaptionLabelComponent(labelProps: CaptionLabelProps) {
      const { className: labelClassName, onClick, children, ...rest } = labelProps;
      const fallbackLabel = formatMonthLabel(currentMonth);
      const labelContent =
        typeof children === "string" || typeof children === "number" ? children : fallbackLabel;
      return (
        <button
          type="button"
          {...rest}
          onClick={(event) => {
            onClick?.(event);
            if (event.defaultPrevented) return;
            setIsSelectingMonthYear(true);
          }}
          className={cx(
            "flex items-center gap-[var(--space-1)] rounded-[var(--radius-control)] px-[var(--space-2)] py-[var(--space-1)]",
            "text-[length:var(--text-control-sm)] font-[var(--font-weight-medium)] text-[var(--color-text-primary)] transition-colors",
            "hover:text-[var(--color-action-primary)]",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-action-primary)]/40",
            labelClassName,
          )}
          aria-label="Choose month and year"
          aria-expanded={isSelectingMonthYear}
        >
          {labelContent}
        </button>
      );
    },
    [currentMonth, isSelectingMonthYear],
  );

  return (
    <div className={cx("flex h-full w-full flex-col bg-[var(--color-bg-surface)]", className)}>
      {isSelectingMonthYear ? (
        <MonthYearSelector
          activeMonth={currentMonth}
          onMonthYearChange={(next) => setCurrentMonth(next)}
          onClose={() => setIsSelectingMonthYear(false)}
        />
      ) : (
        <DayPicker
          mode="single"
          selected={selectedDate}
          month={currentMonth}
          onMonthChange={(month) => setCurrentMonth(month)}
          onSelect={handleSelect}
          required
          showOutsideDays
          navLayout="around"
          className="flex h-full w-full flex-col"
          classNames={DAY_PICKER_CLASS_NAMES}
          disabled={disabledDayRules}
          components={{ CaptionLabel: captionLabelComponent }}
        />
      )}
    </div>
  );
}
