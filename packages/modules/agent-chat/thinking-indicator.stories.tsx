import type { Meta, StoryObj } from "@storybook/react-vite";

import { ThinkingIndicator } from "./ThinkingIndicator";

const meta = {
  title: "Agent Chat / ThinkingIndicator",
  component: ThinkingIndicator,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div
        style={{
          minHeight: "100vh",
          background: "var(--color-bg-page)",
          fontFamily: "var(--font-sans)",
          display: "flex",
          padding: "var(--space-6)",
        }}
      >
        <div style={{ width: "100%", maxWidth: "640px" }}>
          <Story />
        </div>
      </div>
    ),
  ],
} satisfies Meta<typeof ThinkingIndicator>;

export default meta;
type Story = StoryObj<typeof meta>;

// The agent-is-working beat: sparkle avatar + three staggered pulsing dots,
// laid out like an agent turn so the eventual message doesn't jump.
export const Default: Story = {};
