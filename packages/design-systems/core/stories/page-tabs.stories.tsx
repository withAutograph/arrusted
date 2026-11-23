import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { Card, PageTabs } from "../components";

const meta = {
  title: "Design System/Controls/PageTabs",
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="min-h-screen bg-[var(--color-bg-page)] p-[var(--space-6)] text-[var(--color-text-primary)]">
        <div className="mx-auto max-w-[960px]">
          <Story />
        </div>
      </div>
    ),
  ],
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

// 3-tab harness — the canonical page-tab strip inside a section. Generic
// labels keep the story app-domain-free per the prevailing pattern.
function TripleHarness(props: { title?: string }) {
  const [value, setValue] = useState<string>("first");
  return (
    <Card title={props.title ?? "3 tabs"}>
      <div className="grid gap-[var(--space-3)]">
        <PageTabs
          ariaLabel="Page"
          value={value}
          onChange={setValue}
          options={[
            { id: "first", label: "First" },
            { id: "second", label: "Second" },
            { id: "third", label: "Third" },
          ]}
        />
        <p className="m-0 px-[var(--space-4)] text-[length:var(--text-caption)] text-[var(--color-text-muted)]">
          Current value: <code>{value}</code>
        </p>
      </div>
    </Card>
  );
}

// Single-option case — the strip suppresses itself. Wrapped in a Card so
// the absence is visually legible in a screenshot (otherwise the story
// renders blank and reads as a broken capture).
function SingletonHarness() {
  const [value, setValue] = useState<string>("only");
  return (
    <Card title="1 tab (strip suppressed)">
      <div className="grid gap-[var(--space-3)] px-[var(--space-4)] py-[var(--space-3)]">
        <PageTabs
          ariaLabel="Page"
          value={value}
          onChange={setValue}
          options={[{ id: "only", label: "Only" }]}
        />
        <p className="m-0 text-[length:var(--text-caption)] text-[var(--color-text-muted)]">
          PageTabs returns null when <code>options.length &lt;= 1</code>; the strip below the title
          is intentionally empty.
        </p>
      </div>
    </Card>
  );
}

// Longer list so we can eyeball spacing / overflow at the leaf. Real
// consumers should rarely exceed 5–6 page tabs inside a single section;
// past that, regroup the section.
function ManyHarness() {
  const [value, setValue] = useState<string>("alpha");
  return (
    <Card title="6 tabs (longest realistic case)">
      <div className="grid gap-[var(--space-3)]">
        <PageTabs
          ariaLabel="Page"
          value={value}
          onChange={setValue}
          options={[
            { id: "alpha", label: "Alpha" },
            { id: "beta", label: "Beta" },
            { id: "gamma", label: "Gamma" },
            { id: "delta", label: "Delta" },
            { id: "epsilon", label: "Epsilon" },
            { id: "zeta", label: "Zeta" },
          ]}
        />
        <p className="m-0 px-[var(--space-4)] text-[length:var(--text-caption)] text-[var(--color-text-muted)]">
          Current value: <code>{value}</code>
        </p>
      </div>
    </Card>
  );
}

export const Default: Story = {
  render: () => (
    <div className="grid gap-[var(--space-4)]">
      <TripleHarness />
    </div>
  ),
};

export const SingleOption: Story = {
  render: () => (
    <div className="grid gap-[var(--space-4)]">
      <SingletonHarness />
    </div>
  ),
};

export const ManyTabs: Story = {
  render: () => (
    <div className="grid gap-[var(--space-4)]">
      <ManyHarness />
    </div>
  ),
};
