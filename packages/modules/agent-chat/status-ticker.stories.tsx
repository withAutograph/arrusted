import type { Meta, StoryObj } from "@storybook/react-vite";

import { StatusTicker } from "./StatusTicker";
import { tickerRunning, tickerSettled } from "./fixtures";

const meta = {
  title: "Agent Chat / StatusTicker",
  component: StatusTicker,
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
          gap: "var(--space-5)",
          padding: "var(--space-6)",
          maxWidth: "560px",
        }}
      >
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof StatusTicker>;

export default meta;
type Story = StoryObj<typeof meta>;

// Running, collapsed: only the latest state's label, shimmering.
export const RunningCollapsed: Story = {
  args: { ticker: tickerRunning },
};

// Running, expanded: the full accumulated list, tool row still spinning.
export const RunningExpanded: Story = {
  args: { ticker: tickerRunning, defaultExpanded: true },
};

// Settled, collapsed: the quiet "Worked for Xs · N steps" summary, no shimmer.
export const SettledCollapsed: Story = {
  args: { ticker: tickerSettled },
};

// Settled, expanded: the audit surface — every tool call with its outcome and
// the repair attempt ("Fixing 2 issues — attempt 2") visible in order.
export const SettledExpanded: Story = {
  args: { ticker: tickerSettled, defaultExpanded: true },
};

// Side-by-side gallery for a single visual-proof shot.
export const Gallery: Story = {
  args: { ticker: tickerSettled },
  render: () => (
    <>
      <StatusTicker ticker={tickerRunning} />
      <StatusTicker ticker={tickerRunning} defaultExpanded />
      <StatusTicker ticker={tickerSettled} />
      <StatusTicker ticker={tickerSettled} defaultExpanded />
    </>
  ),
};
