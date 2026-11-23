import type { Meta, StoryObj } from "@storybook/react-vite";

import { AnchorChip } from "./AnchorChip";
import { anchor } from "./fixtures";

const meta = {
  title: "Agent Chat / AnchorChip",
  component: AnchorChip,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div
        style={{
          minHeight: "100vh",
          background: "var(--color-bg-page)",
          fontFamily: "var(--font-sans)",
          display: "flex",
          alignItems: "flex-start",
          padding: "var(--space-6)",
          gap: "var(--space-3)",
          flexWrap: "wrap",
        }}
      >
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof AnchorChip>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WithScope: Story = {
  args: { anchor },
};

export const SurfaceOnly: Story = {
  args: { anchor: { surface: "Positions grid" } },
};

export const Filtered: Story = {
  args: {
    anchor: { surface: "Positions grid", scope: "filtered to Engineering" },
  },
};
