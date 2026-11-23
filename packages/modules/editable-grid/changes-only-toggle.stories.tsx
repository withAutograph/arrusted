// ChangesOnlyToggle stories — round-checkbox + "Show changes only" label.
//
// Three states: off (default), on, disabled. The checkbox class
// (`.checkbox`) matches AG Grid Quartz's row-selection checkbox so
// the visual reads as ONE primitive across the surface.

import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { ChangesOnlyToggle } from "./changes-only-toggle";

function ToggleHarness(props: { initial: boolean; disabled?: boolean }) {
  const [on, setOn] = useState(props.initial);
  return <ChangesOnlyToggle on={on} onChange={setOn} disabled={props.disabled} />;
}

const meta = {
  title: "Editable Grid/Chrome/ChangesOnlyToggle",
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="min-h-screen bg-[var(--color-bg-page)] p-[var(--space-6)] text-[var(--color-text-primary)]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const Off: Story = {
  render: () => <ToggleHarness initial={false} />,
};

export const On: Story = {
  render: () => <ToggleHarness initial />,
};

export const Disabled: Story = {
  render: () => <ToggleHarness initial={false} disabled />,
};
