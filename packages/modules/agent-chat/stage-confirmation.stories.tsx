import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { StageConfirmation } from "./StageConfirmation";
import { proposal } from "./fixtures";

const meta = {
  title: "Agent Chat / StageConfirmation",
  component: StageConfirmation,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div
        style={{
          minHeight: "100vh",
          background: "var(--color-bg-page)",
          fontFamily: "var(--font-sans)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-4)",
          padding: "var(--space-6)",
          maxWidth: "520px",
        }}
      >
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof StageConfirmation>;

export default meta;
type Story = StoryObj<typeof meta>;

const noop = () => {};

export const Ready: Story = {
  args: { proposal, onStage: noop, onDiscard: noop },
};

export const SingleChange: Story = {
  args: {
    proposal: {
      headline: "start date → 2026-08-01",
      changeCount: 1,
      targets: ["Staff SWE"],
    },
    onStage: noop,
    onDiscard: noop,
  },
};

export const Staging: Story = {
  args: { proposal, onStage: noop, onDiscard: noop, staging: true },
};

// Partial-add (§6): repair exhausted with a partially-valid set — the primary
// action offers the passing subset and the failures are listed legibly.
export const PartialAdd: Story = {
  args: {
    proposal: {
      headline: "base pay +4%",
      changeCount: 3,
      targets: ["Eng Mgr", "PM II", "Design Lead"],
      verdict: "Checked · 3 of 5 changes look good, 2 need attention",
      partial: {
        passedCount: 3,
        failures: [
          { target: "Staff SWE · base pay", reason: "above the band max for this level" },
          { target: "Senior PM · base pay", reason: "would exceed the approved budget" },
        ],
      },
    },
    onStage: noop,
    onDiscard: noop,
  },
};

export const Staged: Story = {
  args: { proposal, onStage: noop, onDiscard: noop, staged: true },
};

// Interactive: proves the Ready → staging → staged transition end to end.
export const Interactive: Story = {
  args: { proposal, onStage: noop, onDiscard: noop },
  render: () => {
    const [state, setState] = useState<"ready" | "staging" | "staged">("ready");
    return (
      <StageConfirmation
        proposal={proposal}
        staging={state === "staging"}
        staged={state === "staged"}
        onStage={() => {
          setState("staging");
          setTimeout(() => setState("staged"), 600);
        }}
        onDiscard={() => setState("ready")}
      />
    );
  },
};

// A host that stages somewhere other than a grid (the comp canvas's session
// staged changes) supplies its own copy and a per-change list.
export const HostCopyWithDetails: Story = {
  args: {
    proposal: {
      headline: "by rule: raise to band minimum, capped at 8%",
      changeCount: 2,
      targets: [],
    },
    labels: { ready: "Proposed", stage: "Pull all into staged", discard: "Dismiss" },
    details: (
      <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12 }}>
        <li>Ava Chen · Base salary: $132,000 → $142,560</li>
        <li>Ben Ito · Base salary: $120,000 → $129,600</li>
      </ul>
    ),
    onStage: noop,
    onDiscard: noop,
  },
};
