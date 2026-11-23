/*
 * DateField — form-friendly trigger + popover composition over the
 * DatePickerCalendar atom.
 *
 * Stories cover the empty placeholder, a pre-picked value, the disabled
 * state, and a side-by-side pair (matches the form layout in the
 * NewPositionSheet's Start date / End date pair).
 */
import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { Card, DateField, FieldFrame } from "../components";

const meta = {
  title: "Design System/Controls/DateField",
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

function FieldHarness(props: {
  initialValue?: string;
  label?: string;
  helper?: string;
  disabled?: boolean;
  placeholder?: string;
}) {
  const [value, setValue] = useState(props.initialValue ?? "");
  return (
    <Card title="Date Field">
      <FieldFrame label={props.label ?? "Effective date"} helper={props.helper}>
        <DateField
          ariaLabel={props.label ?? "Effective date"}
          value={value}
          onChange={setValue}
          disabled={props.disabled}
          placeholder={props.placeholder}
        />
      </FieldFrame>
    </Card>
  );
}

export const EmptyPlaceholder: Story = {
  render: () => <FieldHarness helper="Click to open the calendar popover." />,
};

export const WithDate: Story = {
  render: () => <FieldHarness initialValue="2026-09-01" />,
};

export const Disabled: Story = {
  render: () => (
    <FieldHarness
      disabled
      initialValue="2026-09-01"
      helper="The trigger is non-interactive and the popover cannot open."
    />
  ),
};

export const CustomPlaceholder: Story = {
  render: () => (
    <FieldHarness
      placeholder="Select effective start"
      helper="Override the default 'Pick a date' copy."
    />
  ),
};

function DateRangeHarness() {
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  return (
    <Card title="Date Range (Sheet form pattern)">
      <div className="grid grid-cols-[1fr_1fr] gap-[var(--space-3)]">
        <FieldFrame label="Start date">
          <DateField ariaLabel="Start date" value={start} onChange={setStart} />
        </FieldFrame>
        <FieldFrame label="End date">
          <DateField ariaLabel="End date" value={end} onChange={setEnd} />
        </FieldFrame>
      </div>
    </Card>
  );
}

export const DateRange: Story = {
  render: () => <DateRangeHarness />,
};
