// DateField — atom-+-trigger composition that wraps the
// `DatePickerCalendar` atom in a form-friendly trigger button + popover.
// The button shows the picked value (or a placeholder), opens a popover
// with the calendar grid on click, dismisses on Escape / click-outside,
// and returns focus to the trigger after a pick or Escape.
//
// Apps that want a different trigger style (pill, raw input, chevron-
// only) compose their own around the `DatePickerCalendar` atom; this
// component is the standard form-field shape used by sheet forms.

import { useEffect, useRef, useState } from "react";

import { Calendar } from "../icons";
import { DatePickerCalendar } from "./date-picker";
import { localDate } from "./date-picker/helpers";
import { cx } from "./utils";

export type DateFieldProps = {
  ariaLabel: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
};

// Render an ISO `YYYY-MM-DD` as `Mon DD, YYYY` for the trigger display.
// Inlined here because it's small, internal, and the only consumer is
// this component.
function formatDateForDisplay(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const [y, m, d] = value.split("-").map(Number);
  if (y === undefined || m === undefined || d === undefined) return value;
  const date = localDate(y, m - 1, d);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { month: "short", day: "2-digit", year: "numeric" });
}

export function DateField(props: DateFieldProps) {
  const { ariaLabel, value, onChange, disabled = false, placeholder = "Pick a date" } = props;
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: PointerEvent) {
      const target = event.target;
      if (target instanceof Node && containerRef.current?.contains(target)) return;
      setOpen(false);
    }
    function handleKey(event: globalThis.KeyboardEvent) {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus({ preventScroll: true });
    }
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative w-full">
      <button
        ref={triggerRef}
        type="button"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-haspopup="dialog"
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        className={cx(
          "flex h-[var(--size-input-md)] w-full items-center justify-between rounded-[var(--radius-control)]",
          "border border-[var(--color-border-strong)] bg-[var(--color-bg-surface)]",
          "px-[var(--space-3)] text-left text-[length:var(--text-control-md)]",
          "font-[family-name:var(--font-sans)] text-[var(--color-text-primary)]",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-action-primary)]/30",
          disabled && "cursor-not-allowed opacity-50",
        )}
      >
        <span className={value ? "" : "text-[var(--color-text-muted)]"}>
          {value ? formatDateForDisplay(value) : placeholder}
        </span>
        <Calendar className="h-[var(--size-icon-sm)] w-[var(--size-icon-sm)] text-[var(--color-text-muted)]" />
      </button>
      {open ? (
        <div
          className={cx(
            "absolute left-0 top-[calc(100%+var(--space-1))] z-[var(--z-popover)]",
            "overflow-hidden rounded-[var(--radius-panel)] border border-[var(--color-border-subtle)]",
            "bg-[var(--color-bg-surface)] shadow-[var(--shadow-raised)]",
          )}
          style={{
            width: "var(--size-date-picker-popover)",
            height: "var(--size-date-picker-popover)",
          }}
        >
          <DatePickerCalendar
            value={value}
            onSelect={(next) => {
              onChange(next);
              setOpen(false);
              triggerRef.current?.focus({ preventScroll: true });
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
