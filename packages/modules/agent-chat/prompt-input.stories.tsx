import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { PromptInput } from "./PromptInput";

const meta = {
  title: "Agent Chat / PromptInput",
  component: PromptInput,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div
        style={{
          minHeight: "100vh",
          background: "var(--color-bg-page)",
          fontFamily: "var(--font-sans)",
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "center",
          padding: "var(--space-6)",
        }}
      >
        <div style={{ width: "100%", maxWidth: "640px" }}>
          <Story />
        </div>
      </div>
    ),
  ],
} satisfies Meta<typeof PromptInput>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {
  render: () => <PromptInput onSend={() => {}} />,
};

// Proves the sent-text callback fires and the composer clears.
export const Interactive: Story = {
  render: () => {
    const [sent, setSent] = useState<{ id: string; text: string }[]>([]);
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-3)",
        }}
      >
        {sent.length > 0 ? (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "var(--space-1)",
              color: "var(--color-text-muted)",
              fontSize: "var(--text-caption)",
            }}
          >
            {sent.map((item) => (
              <span key={item.id}>sent: {item.text}</span>
            ))}
          </div>
        ) : null}
        <PromptInput
          onSend={(text) => setSent((prev) => [...prev, { id: `${prev.length}-${text}`, text }])}
        />
      </div>
    );
  },
};

export const AgentWorking: Story = {
  render: () => <PromptInput onSend={() => {}} isRunning />,
};
