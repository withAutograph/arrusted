import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { AsOfDatePill, Card } from "../components";

const meta = {
  title: "Design System/Controls/AsOfDatePill",
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="min-h-screen bg-[var(--color-bg-page)] p-[var(--space-6)] text-[var(--color-text-primary)]">
        <div className="mx-auto max-w-[640px]">
          <Story />
        </div>
      </div>
    ),
  ],
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

function Harness(props: { initial: string; minDate?: string; maxDate?: string; helper?: string }) {
  const [value, setValue] = useState(props.initial);
  return (
    <Card title="As-of date pill">
      <div className="grid gap-[var(--space-3)]">
        <div>
          <AsOfDatePill
            value={value}
            onValueChange={setValue}
            minDate={props.minDate}
            maxDate={props.maxDate}
          />
        </div>
        <p className="m-0 text-[length:var(--text-caption)] text-[var(--color-text-muted)]">
          Current value: <code>{value || "(empty)"}</code>
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

export const Default: Story = {
  render: () => (
    <Harness
      initial="2026-07-15"
      helper="Click the pill. The popover surfaces a Today chip and the inline calendar. Selecting a day commits and closes; no Apply/Cancel."
    />
  ),
};

export const Empty: Story = {
  render: () => <Harness initial="" helper="No initial value. Click Today or any day to set it." />,
};

export const ConstrainedToScopeWindow: Story = {
  render: () => (
    <Harness
      initial="2026-04-15"
      minDate="2026-01-01"
      maxDate="2026-12-31"
      helper="minDate and maxDate constrain the calendar; out-of-range days are disabled."
    />
  ),
};

export const FarPastInitial: Story = {
  render: () => (
    <Harness
      initial="2018-03-01"
      helper="Click the month label in the calendar to jump via the year/month drill-down."
    />
  ),
};
