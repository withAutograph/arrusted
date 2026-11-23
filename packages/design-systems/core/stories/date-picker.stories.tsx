/*
 * DatePickerCalendar — atom story.
 *
 * Renders the calendar grid inline (no trigger, no popover wrapper). The
 * calendar IS the atom; consumers compose their own trigger + popover
 * (AsOfDatePill, AG Grid cell-editor adapter, NewPositionSheet's date field).
 *
 * Sample composition (form trigger + popover) is shown in
 * `apps/hc/frontend/src/pages/NewPositionSheet.tsx`.
 */
import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { Card, DatePickerCalendar } from "../components";

const meta = {
  title: "Design System/Controls/DatePickerCalendar",
  parameters: {
    layout: "fullscreen",
  },
  decorators: [
    (Story) => (
      <div className="min-h-screen bg-[var(--color-bg-page)] p-[var(--space-6)] text-[var(--color-text-primary)]">
        <div className="mx-auto max-w-[var(--size-modal-md)]">
          <Story />
        </div>
      </div>
    ),
  ],
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

function CalendarHarness(props: {
  initialValue?: string;
  minDate?: string;
  maxDate?: string;
  helper?: string;
  title?: string;
}) {
  const [value, setValue] = useState(props.initialValue ?? "");
  return (
    <Card title={props.title ?? "Date Picker Calendar"}>
      <div className="flex flex-col gap-[var(--space-3)]">
        <div
          className="overflow-hidden rounded-[var(--radius-panel)] border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] shadow-[var(--shadow-raised)]"
          style={{
            width: "var(--size-date-picker-popover)",
            height: "var(--size-date-picker-popover)",
          }}
        >
          <DatePickerCalendar
            value={value}
            onSelect={setValue}
            minDate={props.minDate}
            maxDate={props.maxDate}
          />
        </div>
        <p className="m-0 text-[length:var(--text-caption)] text-[var(--color-text-muted)]">
          Current value: {value || "(empty)"}
        </p>
        {props.helper ? (
          <p className="m-0 text-[length:var(--text-caption)] text-[var(--color-text-muted)]">
            {props.helper}
          </p>
        ) : null}
      </div>
    </Card>
  );
}

export const DefaultBlank: Story = {
  render: () => (
    <CalendarHarness helper="Click a day to commit. Use the month label to drill into year selection." />
  ),
};

export const WithDate: Story = {
  render: () => <CalendarHarness initialValue="2026-09-01" />,
};

export const WithMinMaxBounds: Story = {
  render: () => (
    <CalendarHarness
      initialValue="2026-09-15"
      minDate="2026-09-10"
      maxDate="2026-09-20"
      helper="Only Sep 10–20, 2026 are selectable."
    />
  ),
};

export const MonthYearDrillDown: Story = {
  render: () => (
    <CalendarHarness
      initialValue="1995-06-15"
      helper="Click the month/year label in the header to drill into year and month selection."
    />
  ),
};
