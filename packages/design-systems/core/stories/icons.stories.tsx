import type { Meta, StoryObj } from "@storybook/react-vite";

import * as Icons from "../icons";

type IconEntry = readonly [name: string, Component: Icons.IconComponent];

const ICON_ENTRIES: IconEntry[] = Object.entries(Icons)
  .filter(([, value]) => typeof value === "object" || typeof value === "function")
  .map(([name, value]) => [name, value as Icons.IconComponent]);

function IconGrid() {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-[var(--space-3)] p-[var(--space-4)]">
      {ICON_ENTRIES.map(([name, Icon]) => (
        <div
          key={name}
          className="flex flex-col items-center gap-[var(--space-2)] rounded-[var(--radius-control)] border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] p-[var(--space-3)]"
        >
          <Icon className="h-[var(--space-5)] w-[var(--space-5)] text-[var(--color-text-primary)]" />
          <code className="text-[length:var(--text-caption)] text-[var(--color-text-secondary)]">
            {name}
          </code>
        </div>
      ))}
    </div>
  );
}

const meta = {
  title: "Design System/Foundations/Icons",
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="min-h-screen bg-[var(--color-bg-page)]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Catalog: Story = {
  render: () => <IconGrid />,
};
