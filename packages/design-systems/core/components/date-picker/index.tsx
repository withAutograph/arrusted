/*
 * Date picker barrel.
 *
 * The date "picker" leaf is just `DatePickerCalendar` — the calendar grid +
 * month/year drill-down. NO outer trigger, NO outer popover. Consumers
 * (cell-editor adapter in AG Grid popups, sheet forms with their own
 * trigger+popover, AsOfDatePill with its pill+popover) wrap the atom in
 * whatever positioning + trigger they need.
 *
 * The previous composed `DatePicker` (input + popover + calendar) was deleted
 * in the leaf-atoms refactor: every consumer either already wanted a different
 * trigger style (AsOfDatePill, NewPositionSheet, AG Grid popup) or was
 * speculative (the storybook-only inputs).
 *
 * Helpers + the calendar atom remain exported from here.
 */
export { DatePickerCalendar, type DatePickerCalendarProps } from "./calendar";
export type { LocalDateString } from "./helpers";
