import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { Card, SegmentedControl } from "../components";

const meta = {
  title: "Design System/Controls/SegmentedControl",
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

// 3-option harness — the canonical "Read / Tweak / Edit" triple-pill shape,
// using generic labels so the story stays app-domain-free.
function TripleHarness(props: {
  intent?: "primary" | "neutral";
  size?: "sm" | "md";
  title?: string;
}) {
  const [value, setValue] = useState<"small" | "medium" | "large">("medium");
  return (
    <Card title={props.title ?? "3-option"}>
      <div className="grid gap-[var(--space-3)]">
        <SegmentedControl<"small" | "medium" | "large">
          ariaLabel="Density"
          intent={props.intent}
          size={props.size}
          value={value}
          onChange={setValue}
          options={[
            { value: "small", label: "Small" },
            { value: "medium", label: "Medium" },
            { value: "large", label: "Large" },
          ]}
        />
        <p className="m-0 text-[length:var(--text-caption)] text-[var(--color-text-muted)]">
          Current value: <code>{value}</code>
        </p>
      </div>
    </Card>
  );
}

function PairHarness(props: { intent?: "primary" | "neutral" }) {
  const [value, setValue] = useState<"first" | "second">("first");
  return (
    <Card title={`2-option (intent: ${props.intent ?? "primary"})`}>
      <div className="grid gap-[var(--space-3)]">
        <SegmentedControl<"first" | "second">
          ariaLabel="Tab"
          intent={props.intent}
          value={value}
          onChange={setValue}
          options={[
            { value: "first", label: "First (12)" },
            { value: "second", label: "Second (3)" },
          ]}
        />
        <p className="m-0 text-[length:var(--text-caption)] text-[var(--color-text-muted)]">
          Current value: <code>{value}</code>
        </p>
      </div>
    </Card>
  );
}

export const Default: Story = {
  render: () => (
    <div className="grid gap-[var(--space-4)]">
      <TripleHarness title="3-option (primary intent — default)" />
      <PairHarness />
      <PairHarness intent="neutral" />
    </div>
  ),
};

export const Sizes: Story = {
  render: () => (
    <div className="grid gap-[var(--space-4)]">
      <TripleHarness size="sm" title="size sm" />
      <TripleHarness size="md" title="size md (default)" />
    </div>
  ),
};

export const Intents: Story = {
  render: () => (
    <div className="grid gap-[var(--space-4)]">
      <TripleHarness intent="primary" title="intent primary (default — high contrast)" />
      <TripleHarness intent="neutral" title="intent neutral (alongside a primary CTA)" />
    </div>
  ),
};

function CountHarness(props: { intent?: "primary" | "neutral" }) {
  const [value, setValue] = useState<"work" | "review">("work");
  return (
    <Card title={`With a count (intent: ${props.intent ?? "primary"})`}>
      <SegmentedControl<"work" | "review">
        ariaLabel="Mode"
        intent={props.intent}
        size="sm"
        value={value}
        onChange={setValue}
        options={[
          { value: "work", label: "Work" },
          { value: "review", label: "Review", count: 3, ariaLabel: "Review, 3 waiting" },
        ]}
      />
    </Card>
  );
}

/** A count badge after a segment's label, legible on both the active and inactive segment. */
export const WithCount: Story = {
  render: () => (
    <div className="grid gap-[var(--space-4)]">
      <CountHarness />
      <CountHarness intent="neutral" />
    </div>
  ),
};
