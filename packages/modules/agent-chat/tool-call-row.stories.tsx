import type { Meta, StoryObj } from "@storybook/react-vite";

import { ToolCallRow } from "./ToolCallRow";
import { toolDone, toolEmpty, toolError, toolRunning } from "./fixtures";

const meta = {
  title: "Agent Chat / ToolCallRow",
  component: ToolCallRow,
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
          gap: "var(--space-3)",
          padding: "var(--space-6)",
          maxWidth: "560px",
        }}
      >
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ToolCallRow>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Running: Story = { args: { tool: toolRunning } };
export const Done: Story = { args: { tool: toolDone } };
export const NoMatches: Story = { args: { tool: toolEmpty } };
export const Error: Story = { args: { tool: toolError } };

export const AllStates: Story = {
  args: { tool: toolDone },
  render: () => (
    <>
      <ToolCallRow tool={toolRunning} />
      <ToolCallRow tool={toolDone} />
      <ToolCallRow tool={toolEmpty} />
      <ToolCallRow tool={toolError} />
    </>
  ),
};
