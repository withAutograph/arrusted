import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { ClipboardDocumentList } from "../icons";
import { DecisionOptionCard, KpiCard, KpiPill, NativeSelect, PageHeader, Tag } from "../components";

const meta = {
  title: "Design System/Review Queue",
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="min-h-screen bg-[var(--color-bg-page)] p-[var(--space-6)]">
        <div className="mx-auto grid max-w-[800px] gap-[var(--space-6)]">
          <Story />
        </div>
      </div>
    ),
  ],
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const IdentityDecision: Story = { render: () => <IdentityDecisionFixture /> };

function IdentityDecisionFixture() {
  const [selected, setSelected] = useState("acme");
  const [decision, setDecision] = useState<"merge" | "keep-separate">("merge");
  return (
    <>
      <PageHeader title="Identity review" subtitle="Choose the canonical identity to keep." />
      <KpiCard
        icon={ClipboardDocumentList}
        title="Open identity questions"
        value="3"
        valueLabel="questions"
        pills={<KpiPill label="Currency-safe evidence" emphasis />}
      />
      <NativeSelect
        ariaLabel="Canonical identity"
        value={selected}
        options={[
          { value: "acme", label: "Acme" },
          { value: "acme-inc", label: "Acme, Inc." },
        ]}
        onValueChange={setSelected}
      />
      <div role="radiogroup" className="grid gap-[var(--space-3)]">
        <DecisionOptionCard
          name="identity-decision"
          value="merge"
          density="compact"
          title="Merge these identities"
          description="Future source evidence resolves to the selected canonical identity."
          selected={decision === "merge"}
          tag={<Tag label="Durable" tone="green" />}
          onSelect={() => setDecision("merge")}
        />
        <DecisionOptionCard
          name="identity-decision"
          value="keep-separate"
          density="compact"
          title="Keep separate"
          description="Remember that this exact pair is not a duplicate."
          selected={decision === "keep-separate"}
          onSelect={() => setDecision("keep-separate")}
        />
      </div>
    </>
  );
}
