// DatetimeEditor — the shared date calendar plus a time input, editing a
// `datetime` FieldValue in UTC.
//
// The kernel accepts RFC 3339 timestamps with seconds and a `Z` or `±HH:MM`
// offset, and reads them back normalized to UTC (`…Z`). The editor therefore
// edits and commits UTC, labelled as such, so what the user picks is exactly
// what the cell shows after Save, whatever the browser's time zone.
//
// Atom-only: no border or shadow; the host (AG Grid popup) supplies chrome.

import { useRef, useState } from "react";
import type { FieldValue } from "@contracts";

import { Button } from "../../Button";
import { DatePickerCalendar } from "../../date-picker";
import { TextField } from "../../FormControls";
import { ClearValueAction } from "../clear-value-action";
import type { EditorContext, EditorProps, FieldEditor } from "../protocol";

export type DatetimeEditValue = {
  /** UTC calendar date, `YYYY-MM-DD`, or "" when unset. */
  date: string;
  /** UTC wall time, `HH:MM`. */
  time: string;
  /** Seconds and fraction kept from the stored value (`:SS[.fraction]`). */
  seconds: string;
};

const DATETIME_TEXT =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?\s*(Z|UTC|[+-]\d{2}:?\d{2})?$/iu;

// Parses a typed or pasted date and time into the kernel's canonical UTC form
// (`YYYY-MM-DDTHH:MM:SS[.fraction]Z`). Text without an offset is read as UTC,
// like the editor. The fraction's digits are kept as written (offsets are whole
// minutes, so converting to UTC never changes them). Returns null for anything
// that is not a real date and time, including a bare date, which would
// otherwise become a silent midnight.
export function parseDatetimeText(text: string): string | null {
  const match = DATETIME_TEXT.exec(text.trim());
  if (!match) return null;
  const [, y, mo, d, h, mi, s = "00", fraction = "", zone = "Z"] = match;
  const year = Number(y);
  const month = Number(mo) - 1;
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(s);
  if (year < 1 || hour > 23 || minute > 59 || second > 59) return null;
  // setUTCFullYear, unlike Date.UTC, does not map years 0-99 to 1900-1999.
  const local = new Date(0);
  local.setUTCFullYear(year, month, day);
  local.setUTCHours(hour, minute, second, 0);
  if (
    local.getUTCFullYear() !== year ||
    local.getUTCMonth() !== month ||
    local.getUTCDate() !== day
  ) {
    return null;
  }
  const offsetMinutes = zoneOffsetMinutes(zone);
  if (offsetMinutes === null) return null;
  const instant = new Date(local.getTime() - offsetMinutes * 60_000);
  // An offset can push year 0001 back into year 0000, which is invalid.
  if (Number.isNaN(instant.getTime()) || instant.getUTCFullYear() < 1) return null;
  const iso = instant.toISOString();
  if (!/^\d{4}-/u.test(iso)) return null;
  return `${iso.slice(0, 19)}${fraction}Z`;
}

function zoneOffsetMinutes(zone: string): number | null {
  const upper = zone.toUpperCase();
  if (upper === "Z" || upper === "UTC") return 0;
  const match = /^([+-])(\d{2}):?(\d{2})$/u.exec(zone);
  if (!match) return null;
  const [, sign, hh, mm] = match;
  if (Number(hh) > 23 || Number(mm) > 59) return null;
  const minutes = Number(hh) * 60 + Number(mm);
  return sign === "-" ? -minutes : minutes;
}

export function datetimeEditValue(value: string | null | undefined): DatetimeEditValue {
  const canonical = value ? parseDatetimeText(value) : null;
  if (!canonical) return { date: "", time: "00:00", seconds: ":00" };
  return {
    date: canonical.slice(0, 10),
    time: canonical.slice(11, 16),
    seconds: canonical.slice(16, -1),
  };
}

export function datetimeFromEditValue(value: DatetimeEditValue): string {
  return `${value.date}T${value.time}${value.seconds}Z`;
}

const TIME_TEXT = /^\d{2}:\d{2}$/u;

function DatetimeEditorComponent(props: EditorProps<DatetimeEditValue>) {
  const { initialValue, context, onCancel, onClear, onCommit, onDraftChange } = props;
  const [date, setDate] = useState(initialValue.date);
  const [time, setTime] = useState(initialValue.time);
  const [error, setError] = useState<"time" | "date" | null>(null);
  const finishedRef = useRef(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const label = context.fieldType.label ?? context.fieldId;
  const errorId = `${context.fieldId}-datetime-time-error`;

  // What committing now would save, or null when there is nothing to save.
  function draftFor(nextDate: string, nextTime: string): DatetimeEditValue | null {
    if (!nextDate || !TIME_TEXT.test(nextTime)) return null;
    if (nextDate === initialValue.date && nextTime === initialValue.time) return null;
    // A changed time starts on the minute; an untouched one keeps its seconds.
    const seconds = nextTime === initialValue.time ? initialValue.seconds : ":00";
    return { date: nextDate, time: nextTime, seconds };
  }

  function update(nextDate: string, nextTime: string) {
    setDate(nextDate);
    setTime(nextTime);
    if (error === "time" && TIME_TEXT.test(nextTime)) setError(null);
    if (error === "date" && nextDate) setError(null);
    onDraftChange?.(draftFor(nextDate, nextTime));
  }

  function commit() {
    if (finishedRef.current) return;
    const changed = date !== initialValue.date || time !== initialValue.time;
    // A changed value missing its date or time stays open with an error
    // rather than discarding the change.
    if (changed && !date) {
      setError("date");
      return;
    }
    if (changed && !TIME_TEXT.test(time)) {
      setError("time");
      return;
    }
    finishedRef.current = true;
    const draft = draftFor(date, time);
    if (draft) onCommit(draft);
    else onCancel();
  }

  function cancel() {
    if (finishedRef.current) return;
    finishedRef.current = true;
    onCancel();
  }

  return (
    <div
      ref={rootRef}
      className="flex w-[var(--size-date-picker-popover)] flex-col"
      onBlur={(event) => {
        const nextFocus = event.relatedTarget;
        if (nextFocus instanceof Node && rootRef.current?.contains(nextFocus)) return;
        if (nextFocus === null) return;
        commit();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          cancel();
        }
      }}
    >
      {onClear ? (
        <div className="px-[var(--space-2)] pt-[var(--space-2)]">
          <ClearValueAction
            onClear={() => {
              if (finishedRef.current) return;
              finishedRef.current = true;
              onClear();
            }}
          />
        </div>
      ) : null}
      <div style={{ height: "var(--size-date-picker-popover)" }}>
        <DatePickerCalendar
          value={date}
          onSelect={(next) => {
            if (next) update(next, time);
          }}
        />
      </div>
      <div className="flex flex-col gap-[var(--space-1)] border-t border-[var(--color-border-subtle)] px-[var(--space-3)] py-[var(--space-2)]">
        <div className="flex items-center gap-[var(--space-2)]">
          <TextField
            aria-describedby={error ? errorId : undefined}
            aria-invalid={error === "time" || undefined}
            aria-label={`${label} time (UTC)`}
            autoFocus
            className="w-auto tabular-nums"
            size="sm"
            type="time"
            value={time}
            onValueChange={(next) => update(date, next)}
            onKeyDown={(event) => {
              // stopPropagation so AG Grid's cell-bound listener doesn't race
              // React (see `docs/known-footguns.md` "Editable Grid Host").
              if (event.key === "Enter") {
                event.preventDefault();
                event.stopPropagation();
                commit();
              }
            }}
          />
          <span className="text-[length:var(--text-control-xs)] text-[var(--color-text-muted)]">
            UTC
          </span>
          <Button
            className="ml-auto"
            disabled={!date}
            intent="primary"
            size="xs"
            onMouseDown={(event) => event.preventDefault()}
            onClick={commit}
          >
            Done
          </Button>
        </div>
        {error ? (
          <span
            id={errorId}
            role="alert"
            className="text-[length:var(--text-caption)] text-[var(--color-status-danger)]"
          >
            {error === "date" ? "Pick a date." : "Enter a time."}
          </span>
        ) : null}
      </div>
    </div>
  );
}

export const DatetimeEditor: FieldEditor<
  DatetimeEditValue,
  Extract<FieldValue, { type: "datetime" }>
> = {
  Component: DatetimeEditorComponent,
  mode: "popover",
  parse: (fieldValue, _ctx: EditorContext) => datetimeEditValue(fieldValue?.value),
  serialize: (uiValue, _ctx: EditorContext) => ({
    type: "datetime",
    value: datetimeFromEditValue(uiValue),
  }),
};
