// RunContinuation — the assembled panel's neutral bounded-run state.
//
// Kept as a dedicated story so the visual-proof harness can pin the distinction
// between an expected run limit (neutral Continue action) and a danger/error.

import type { Meta, StoryObj } from "@storybook/react-vite";

import { AgentChatPanel } from "./AgentChatPanel";
import { anchor } from "./fixtures";

const meta = {
  title: "Agent Chat / RunContinuation",
  component: AgentChatPanel,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div
        style={{
          minHeight: "100vh",
          background: "var(--color-bg-page)",
          fontFamily: "var(--font-sans)",
          display: "flex",
          justifyContent: "flex-end",
        }}
      >
        <div style={{ width: "400px", height: "760px" }}>
          <Story />
        </div>
      </div>
    ),
  ],
} satisfies Meta<typeof AgentChatPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const LimitReached: Story = {
  args: {
    anchor,
    messages: [
      {
        id: "m1",
        role: "human",
        parts: [{ kind: "text", text: "Review pay for the selected roles." }],
      },
      {
        id: "m2",
        role: "agent",
        parts: [
          {
            kind: "text",
            text: "I checked the selected roles and started comparing their pay ranges.",
          },
        ],
      },
    ],
    isRunning: false,
    proposal: null,
    clarification: null,
    continuation: {
      message:
        "This run reached its limit before it could finish. Continue to pick up from this conversation.",
      actionLabel: "Continue",
    },
    error: null,
    onSend: () => {},
    onStop: () => {},
    onStage: () => {},
    onDiscard: () => {},
    onAnswerClarification: () => {},
    onContinueRun: () => {},
    onClose: () => {},
  },
};
