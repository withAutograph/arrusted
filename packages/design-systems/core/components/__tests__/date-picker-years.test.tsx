// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  MONTH_OPTIONS,
  deriveVisibleMonth,
  localDate,
  parseDisplayDate,
  parseISODate,
  startOfMonth,
} from "../date-picker/helpers";
import { DateField } from "../DateField";
import { MonthYearSelector } from "../date-picker/month-year-selector";

afterEach(cleanup);

// `new Date(year, ...)` reads years 0-99 as 1900-1999; the picker must not.
describe("date picker years below 100", () => {
  it("keeps the year when building and normalizing months", () => {
    expect(localDate(50, 2, 1).getFullYear()).toBe(50);
    expect(startOfMonth(localDate(7, 5, 20)).getFullYear()).toBe(7);
    const month = deriveVisibleMonth("0050-03-15");
    expect([month?.getFullYear(), month?.getMonth(), month?.getDate()]).toEqual([50, 2, 1]);
    expect(deriveVisibleMonth("0050-03")?.getFullYear()).toBe(50);
    expect(deriveVisibleMonth("0050")?.getFullYear()).toBe(50);
  });

  it("rejects year zero, which the year selector cannot offer", () => {
    expect(parseISODate("0001-01-01")?.getFullYear()).toBe(1);
    expect(parseISODate("0000-03-15")).toBeUndefined();
    expect(parseDisplayDate("Mar 15, 0000")).toBeUndefined();
    expect(parseDisplayDate("Mar 15, 0050")?.getFullYear()).toBe(50);
    expect(deriveVisibleMonth("0000-03-15")).toBeUndefined();
    expect(deriveVisibleMonth("0000-03")).toBeUndefined();
    expect(deriveVisibleMonth("0000")).toBeUndefined();
  });

  it("selects a month in a year below 100", () => {
    const onMonthYearChange = vi.fn();
    render(
      <MonthYearSelector
        activeMonth={localDate(50, 0, 1)}
        onMonthYearChange={onMonthYearChange}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "50" }));
    fireEvent.click(screen.getByTitle(MONTH_OPTIONS[2]!.fullLabel));
    const picked = onMonthYearChange.mock.calls[0]?.[0] as Date;
    expect([picked.getFullYear(), picked.getMonth(), picked.getDate()]).toEqual([50, 2, 1]);
  });

  it("shows a year below 100 on the date field trigger", () => {
    render(<DateField ariaLabel="Start" value="0050-03-15" onChange={() => {}} />);
    const trigger = screen.getByRole("button", { name: /Start/ });
    expect(trigger.textContent).toContain("50");
    expect(trigger.textContent).not.toContain("1950");
  });
});
