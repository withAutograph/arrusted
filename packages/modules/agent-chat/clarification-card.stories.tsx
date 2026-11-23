import type { Meta, StoryObj } from "@storybook/react-vite";

import { ClarificationCard } from "./ClarificationCard";
import type { ClarificationView } from "./types";

const meta = {
  title: "Agent Chat / ClarificationCard",
  component: ClarificationCard,
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
        <div style={{ width: "100%", maxWidth: "460px" }}>
          <Story />
        </div>
      </div>
    ),
  ],
} satisfies Meta<typeof ClarificationCard>;

export default meta;
type Story = StoryObj<typeof meta>;

// An ordinary clarification: self-contained choices that answer on click, plus
// an optional free-text follow-up.
const plain: ClarificationView = {
  headline: "Which roles should the bump apply to?",
  reasoning: "The request didn't say — I'll scope it to what you pick.",
  choices: [
    { id: "eng", label: "Engineering", intent: "primary" },
    { id: "all", label: "All departments", intent: "default" },
  ],
  canAskFollowUp: true,
};

export const ChoicesWithFollowUp: Story = {
  args: { clarification: plain, onAnswer: () => {} },
};

// Free-text only: when the agent needs data / open-ended input it emits NO
// choices — choices exist only when a choice is the complete response.
const freeTextOnly: ClarificationView = {
  headline: "I need the current pay for these roles to compute the bump.",
  reasoning: "I couldn't read them from the grid — paste them so I can proceed.",
  choices: [],
  canAskFollowUp: true,
};

export const FreeTextOnly: Story = {
  args: { clarification: freeTextOnly, onAnswer: () => {} },
};
