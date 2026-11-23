/*
 * AsOfDatePill — a compact pill control for choosing an "as of" date.
 *
 * Click the pill → popover containing a `Today` quick-pick chip and the
 * standalone `DatePickerCalendar` surface. Selecting a day commits and closes;
 * clicking `Today` commits today's local date and closes. ESC and outside
 * click dismiss without committing.
 *
 * No Apply/Cancel buttons, no nested input, no native UA date picker — the
 * commit happens on the click that selected the date. This is a deliberate
 * deviation from the source `as-of-date-pill` (which uses Plan Start / Today /
 * Plan End presets specific to planning context); we keep only `Today`
 * and surface the actual calendar.
 */
import { useCallback, useRef, useState } from "react";

import { Calendar, ChevronDown } from "../../icons";
import { DatePickerCalendar } from "../date-picker";
import { clampISODateString, formatDateForDisplay } from "../date-picker/helpers";
import { BodyPortalPopover } from "../Overlays";
import { cx, type Size } from "../utils";

const PILL_SIZE_CLASS: Record<Size, string> = {
  xs: "h-[var(--size-control-xs)] gap-[var(--space-1)] px-[var(--space-2)] text-[length:var(--text-control-xs)]",
  sm: "h-[var(--size-control-sm)] gap-[var(--space-1-5)] px-[var(--space-3)] text-[length:var(--text-control-sm)]",
  md: "h-[var(--size-control-md)] gap-[var(--space-2)] px-[var(--space-4)] text-[length:var(--text-control-md)]",
  lg: "h-[var(--size-control-lg)] gap-[var(--space-2)] px-[var(--space-4)] text-[length:var(--text-control-md)]",
};

const ICON_SIZE_CLASS: Record<Size, string> = {
  xs: "h-[var(--size-icon-xs)] w-[var(--size-icon-xs)]",
  sm: "h-[var(--size-icon-sm)] w-[var(--size-icon-sm)]",
  md: "h-[var(--size-icon-sm)] w-[var(--size-icon-sm)]",
  lg: "h-[var(--size-icon-md)] w-[var(--size-icon-md)]",
};

export type AsOfDatePillProps = {
  value: string;
  onValueChange: (value: string) => void;
  /** Inclusive lower bound (YYYY-MM-DD). */
  minDate?: string;
  /** Inclusive upper bound (YYYY-MM-DD). */
  maxDate?: string;
  /** Label preceding the date in the pill. Defaults to "As of". */
  label?: string;
  className?: string;
  size?: Size;
};

function todayLocalIso(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function AsOfDatePill(props: AsOfDatePillProps) {
  const { value, onValueChange, minDate, maxDate, label = "As of", className, size = "sm" } = props;
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const closePopover = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
  }, []);

  function commitDate(next: string) {
    onValueChange(next);
    setOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
  }

  const displayValue = formatDateForDisplay(value);

  return (
    <div className={cx("relative inline-flex", className)}>
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`${label}: ${displayValue}`}
        className={cx(
          "inline-flex items-center whitespace-nowrap rounded-[var(--radius-pill)] border border-[var(--color-border-subtle)]",
          "bg-transparent font-[var(--font-weight-medium)] text-[var(--color-text-secondary)]",
          "transition-colors hover:bg-[var(--color-bg-hover)]",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-action-primary)]/40",
          PILL_SIZE_CLASS[size],
        )}
        onClick={() => setOpen((current) => !current)}
      >
        <Calendar className={cx(ICON_SIZE_CLASS[size], "text-[var(--color-action-primary)]")} />
        <span>{label}</span>
        <span className="text-[var(--color-text-primary)]">{displayValue}</span>
        <ChevronDown
          className={cx(
            ICON_SIZE_CLASS[size],
            "text-[var(--color-text-muted)] transition-transform",
            open && "rotate-180",
          )}
        />
      </button>
      <BodyPortalPopover
        open={open}
        anchorRef={triggerRef}
        ariaLabel={`${label} date`}
        onClose={closePopover}
      >
        <div style={{ width: "var(--size-date-picker-popover)" }} className="flex flex-col">
          <div className="flex justify-center px-[var(--space-3)] pt-[var(--space-3)] pb-[var(--space-1)]">
            <button
              type="button"
              className={cx(
                "inline-flex items-center rounded-[var(--radius-pill)] border border-[var(--color-border-subtle)]",
                "bg-transparent px-[var(--space-3)] py-[var(--space-1)]",
                "text-[length:var(--text-control-xs)] font-[var(--font-weight-medium)] text-[var(--color-text-secondary)]",
                "transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-action-primary)]",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-action-primary)]/40",
              )}
              onClick={() => commitDate(clampISODateString(todayLocalIso(), minDate, maxDate))}
            >
              Today
            </button>
          </div>
          <div style={{ height: "var(--size-as-of-date-calendar)" }}>
            <DatePickerCalendar
              value={value}
              onSelect={(next) => {
                if (!next) return;
                commitDate(next);
              }}
              minDate={minDate}
              maxDate={maxDate}
            />
          </div>
        </div>
      </BodyPortalPopover>
    </div>
  );
}
