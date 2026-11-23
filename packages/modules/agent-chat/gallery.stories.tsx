// Combined gallery — the five leaves assembled into a panel-shaped
// composition, so their spacing/rhythm/weight can be judged together against
// the playground bar. This is a VISUAL-PROOF harness, not the shipped panel
// (that lands in PR E on PositionsPage).

import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { AnchorChip } from "./AnchorChip";
import { MessageThread } from "./Message";
import { PromptInput } from "./PromptInput";
import { StageConfirmation } from "./StageConfirmation";
import { anchor, conversation, proposal } from "./fixtures";

const meta = {
  title: "Agent Chat / Gallery",
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div
        style={{
          minHeight: "100vh",
          background: "var(--color-bg-page)",
          fontFamily: "var(--font-sans)",
          display: "flex",
          justifyContent: "center",
          padding: "var(--space-6)",
        }}
      >
        <Story />
      </div>
    ),
  ],
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

function Panel() {
  const [staged, setStaged] = useState(false);
  return (
    <div
      style={{
        width: "420px",
        height: "720px",
        display: "flex",
        flexDirection: "column",
        borderRadius: "var(--radius-shell)",
        border: "1px solid var(--color-border-subtle)",
        background: "var(--color-bg-surface)",
        boxShadow: "var(--shadow-raised)",
        overflow: "hidden",
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "var(--space-3)",
          padding: "var(--space-3) var(--space-4)",
          borderBottom: "1px solid var(--color-border-subtle)",
        }}
      >
        <span
          style={{
            fontSize: "var(--text-control-lg)",
            fontWeight: "var(--font-weight-semibold)",
            color: "var(--color-text-primary)",
          }}
        >
          Agent
        </span>
        <AnchorChip anchor={anchor} />
      </header>

      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-4)",
          padding: "var(--space-4)",
        }}
      >
        <MessageThread messages={conversation} />
        <StageConfirmation
          proposal={proposal}
          staged={staged}
          onStage={() => setStaged(true)}
          onDiscard={() => setStaged(false)}
        />
      </div>

      <div
        style={{
          padding: "var(--space-3) var(--space-4) var(--space-4)",
          borderTop: "1px solid var(--color-border-subtle)",
        }}
      >
        <PromptInput onSend={() => {}} />
      </div>
    </div>
  );
}

export const AssembledPanel: Story = {
  render: () => <Panel />,
};
