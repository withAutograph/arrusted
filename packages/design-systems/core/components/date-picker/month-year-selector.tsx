/*
 * MonthYearSelector + YearSelection + MonthSelection — copied verbatim from
 * Date-picker behavior is preserved from the source implementation
 * (year-grid windowing, two-stage drill-down, range pagination). Only the
 * design tokens and icon imports were swapped.
 */
import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "../../icons";
import { Button } from "../Button";
import { cx } from "../utils";
import {
  MAX_YEAR,
  MAX_YEAR_RANGE_START,
  MIN_YEAR,
  MONTH_OPTIONS,
  YEAR_GRID_BLOCK,
  clampYearRangeStart,
  deriveYearRangeStart,
  localDate,
} from "./helpers";
import { NAV_BUTTON_CLASSES } from "./styles";

const SECTION_LABEL_CLASSES =
  "text-[length:var(--text-micro)] font-[var(--font-weight-medium)] uppercase tracking-[var(--tracking-micro)] text-[var(--color-text-muted)]";

const SELECTION_BUTTON_BASE_CLASSES = cx(
  "flex h-[var(--size-date-cell)] items-center justify-center",
  "rounded-[var(--radius-control)] border border-[var(--color-border-subtle)]",
  "bg-[var(--color-bg-surface)] px-[var(--space-2)]",
  "text-[length:var(--text-control-sm)] font-[var(--font-weight-medium)]",
  "text-[var(--color-text-primary)] transition-colors",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-action-primary)]/40",
  "hover:border-[var(--color-action-primary)] hover:bg-[var(--color-bg-selected)] hover:text-[var(--color-action-primary)]",
);

const SELECTION_BUTTON_ACTIVE_CLASSES = cx(
  "border-[var(--color-action-primary)] bg-[var(--color-action-primary)]",
  "text-[var(--color-text-inverse)] shadow-[var(--shadow-control)]",
  "hover:bg-[var(--color-action-primary)] hover:text-[var(--color-text-inverse)]",
);

type MonthYearSelectorProps = {
  activeMonth: Date;
  onMonthYearChange: (month: Date) => void;
  onClose: () => void;
};

export function MonthYearSelector(props: MonthYearSelectorProps) {
  const { activeMonth, onMonthYearChange, onClose } = props;
  const activeMonthKey = `${activeMonth.getFullYear()}-${activeMonth.getMonth()}`;
  const initialYearRangeStart = clampYearRangeStart(
    deriveYearRangeStart(activeMonth.getFullYear()),
  );
  const [selection, setSelection] = useState<{
    forMonthKey: string;
    stage: "year" | "month";
    yearRangeStart: number;
    pendingYear: number;
  }>(() => ({
    forMonthKey: activeMonthKey,
    stage: "year",
    yearRangeStart: initialYearRangeStart,
    pendingYear: activeMonth.getFullYear(),
  }));
  const activeSelection =
    selection.forMonthKey === activeMonthKey && true
      ? selection
      : {
          forMonthKey: activeMonthKey,
          stage: "year" as const,
          yearRangeStart: initialYearRangeStart,
          pendingYear: activeMonth.getFullYear(),
        };

  const activeYear = activeSelection.pendingYear;
  const activeMonthIndex = activeMonth.getMonth();

  const years = useMemo(() => {
    const items: number[] = [];
    for (let index = 0; index < YEAR_GRID_BLOCK; index += 1) {
      const candidate = activeSelection.yearRangeStart + index;
      if (candidate > MAX_YEAR) break;
      items.push(candidate);
    }
    return items;
  }, [activeSelection.yearRangeStart]);

  const canShowPreviousRange = activeSelection.yearRangeStart > MIN_YEAR;
  const canShowNextRange = activeSelection.yearRangeStart < MAX_YEAR_RANGE_START;

  function handleYearSelect(year: number) {
    setSelection({
      ...activeSelection,
      stage: "month",
      pendingYear: year,
    });
  }

  function handlePreviousRange() {
    setSelection({
      ...activeSelection,
      yearRangeStart: clampYearRangeStart(activeSelection.yearRangeStart - YEAR_GRID_BLOCK),
    });
  }

  function handleNextRange() {
    setSelection({
      ...activeSelection,
      yearRangeStart: clampYearRangeStart(activeSelection.yearRangeStart + YEAR_GRID_BLOCK),
    });
  }

  return (
    <div className="flex h-full w-full flex-col bg-[var(--color-bg-surface)]">
      <div className="flex items-center justify-between px-[var(--space-4)] pb-[var(--space-2)] pt-[var(--space-3)]">
        {activeSelection.stage === "month" ? (
          <Button
            intent="ghost"
            size="sm"
            className="w-[var(--size-date-action-slot)] justify-start text-[var(--color-action-primary)] hover:text-[var(--color-action-primary-hover)]"
            onClick={() => setSelection({ ...activeSelection, stage: "year" })}
          >
            Back
          </Button>
        ) : (
          <span className="w-[var(--size-date-action-slot)] text-[length:var(--text-control-sm)] font-[var(--font-weight-medium)] text-[var(--color-text-primary)]">
            Year
          </span>
        )}
        <span className="text-[length:var(--text-control-sm)] font-[var(--font-weight-medium)] text-[var(--color-text-primary)]">
          {activeSelection.stage === "year" ? "Select year" : `${activeYear} • Select month`}
        </span>
        <Button
          intent="ghost"
          size="sm"
          className="w-[var(--size-date-action-slot)] justify-end text-[var(--color-action-primary)] hover:text-[var(--color-action-primary-hover)]"
          onClick={onClose}
        >
          Close
        </Button>
      </div>

      {activeSelection.stage === "year" ? (
        <YearSelection
          activeYear={activeYear}
          years={years}
          canShowPreviousRange={canShowPreviousRange}
          canShowNextRange={canShowNextRange}
          onPreviousRange={handlePreviousRange}
          onNextRange={handleNextRange}
          onSelect={handleYearSelect}
        />
      ) : (
        <MonthSelection
          activeMonthIndex={activeMonthIndex}
          onSelect={(monthIndex) => {
            onMonthYearChange(localDate(activeYear, monthIndex, 1));
            onClose();
          }}
        />
      )}
    </div>
  );
}

type YearSelectionProps = {
  activeYear: number;
  years: number[];
  canShowPreviousRange: boolean;
  canShowNextRange: boolean;
  onPreviousRange: () => void;
  onNextRange: () => void;
  onSelect: (year: number) => void;
};

function YearSelection(props: YearSelectionProps) {
  const {
    activeYear,
    years,
    canShowPreviousRange,
    canShowNextRange,
    onPreviousRange,
    onNextRange,
    onSelect,
  } = props;

  return (
    <div className="flex flex-1 flex-col gap-[var(--space-3)] px-[var(--space-4)] pb-[var(--space-4)]">
      <div className="flex items-center justify-between">
        <span className={SECTION_LABEL_CLASSES}>Year</span>
        <div className="flex items-center gap-[var(--space-2)]">
          <button
            type="button"
            onClick={onPreviousRange}
            disabled={!canShowPreviousRange}
            aria-label="Show earlier years"
            className={NAV_BUTTON_CLASSES}
          >
            <ChevronLeft className="h-[var(--size-icon-sm)] w-[var(--size-icon-sm)]" />
          </button>
          <button
            type="button"
            onClick={onNextRange}
            disabled={!canShowNextRange}
            aria-label="Show later years"
            className={NAV_BUTTON_CLASSES}
          >
            <ChevronRight className="h-[var(--size-icon-sm)] w-[var(--size-icon-sm)]" />
          </button>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-[var(--space-2)]">
        {years.map((year) => (
          <button
            key={year}
            type="button"
            onClick={() => onSelect(year)}
            aria-pressed={activeYear === year}
            className={cx(
              SELECTION_BUTTON_BASE_CLASSES,
              "tabular-nums",
              activeYear === year && SELECTION_BUTTON_ACTIVE_CLASSES,
            )}
          >
            {year}
          </button>
        ))}
      </div>
    </div>
  );
}

type MonthSelectionProps = {
  activeMonthIndex: number;
  onSelect: (monthIndex: number) => void;
};

function MonthSelection(props: MonthSelectionProps) {
  const { activeMonthIndex, onSelect } = props;

  return (
    <div className="flex flex-1 flex-col gap-[var(--space-3)] px-[var(--space-4)] pb-[var(--space-4)]">
      <span className={SECTION_LABEL_CLASSES}>Month</span>
      <div className="grid grid-cols-4 gap-[var(--space-2)]">
        {MONTH_OPTIONS.map((month) => (
          <button
            key={month.index}
            type="button"
            onClick={() => onSelect(month.index)}
            aria-pressed={activeMonthIndex === month.index}
            className={cx(
              SELECTION_BUTTON_BASE_CLASSES,
              activeMonthIndex === month.index && SELECTION_BUTTON_ACTIVE_CLASSES,
            )}
            title={month.fullLabel}
          >
            {month.shortLabel}
          </button>
        ))}
      </div>
    </div>
  );
}
